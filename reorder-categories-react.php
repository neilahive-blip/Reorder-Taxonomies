<?php
/**
 * Plugin Name: Reorder Taxonomies (React-style Admin)
 * Description: Dedicated admin page to reorder hierarchical taxonomies for all post types with drag/drop UI and REST endpoints.
 * Version: 1.3.0
 * Author: Neila Sadji
 * Text Domain: reorder-categories-react
 */

if (!defined('ABSPATH')) exit;

/**
 * Add admin page under Tools
 */
add_action('admin_menu', function () {
    add_management_page(
        __('Reorder Taxonomies', 'reorder-categories-react'),
        __('Reorder Taxonomies', 'reorder-categories-react'),
        'manage_categories',
        'reorder-taxonomies',
        'rcr_render_admin_page'
    );
});

function rcr_render_admin_page() { ?>
    <div class="wrap">
        <h1><?php esc_html_e('Reorder Taxonomies', 'reorder-categories-react'); ?></h1>
        <p><?php esc_html_e('Select a taxonomy and reorder its terms with drag and drop.', 'reorder-categories-react'); ?></p>
        <div id="rcr-root"></div>
    </div>
<?php }

/**
 * Enqueue scripts
 */
add_action('admin_enqueue_scripts', function ($hook) {
    if ($hook !== 'tools_page_reorder-taxonomies') return;

    wp_enqueue_script(
        'sortablejs',
        'https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js',
        [],
        '1.15.0',
        true
    );

    wp_enqueue_script(
        'rcr-admin-js',
        plugin_dir_url(__FILE__) . 'assets/js/reorder-admin.js',
        ['wp-element', 'sortablejs'],
        '1.3.0',
        true
    );

    wp_enqueue_style(
        'rcr-admin-css',
        plugin_dir_url(__FILE__) . 'assets/css/reorder-admin.css',
        [],
        '1.3.0'
    );

    // ✅ Get ALL hierarchical public taxonomies across all post types
    $taxonomies = get_taxonomies(['hierarchical' => true, 'public' => true], 'objects');
    $available_taxonomies = [];

    foreach ($taxonomies as $tax) {
        if (current_user_can('manage_categories')) {
            $available_taxonomies[$tax->name] = $tax->label;
        }
    }

    wp_localize_script('rcr-admin-js', 'rcr_params', [
        'nonce'       => wp_create_nonce('wp_rest'),
        'rest_base'   => esc_url_raw(rest_url('reorder/v1')),
        'taxonomies'  => $available_taxonomies,
        'default_tax' => !empty($available_taxonomies) ? key($available_taxonomies) : '',
    ]);
});

/**
 * REST: get terms tree
 */
add_action('rest_api_init', function () {
    register_rest_route('reorder/v1', '/terms', [
        'methods'             => 'GET',
        'callback'            => 'rcr_get_terms_tree',
        'permission_callback' => fn() => current_user_can('manage_categories'),
        'args' => [
            'taxonomy' => [
                'required' => true,
                'type'     => 'string',
                'validate_callback' => fn($value) => taxonomy_exists($value) && is_taxonomy_hierarchical($value),
            ],
        ],
    ]);

    register_rest_route('reorder/v1', '/save', [
        'methods'             => 'POST',
        'callback'            => 'rcr_save_terms_order',
        'permission_callback' => fn() => current_user_can('manage_categories'),
        'args' => [
            'taxonomy' => [
                'required' => true,
                'type'     => 'string',
                'validate_callback' => fn($value) => taxonomy_exists($value) && is_taxonomy_hierarchical($value),
            ],
        ],
    ]);
});

function rcr_get_terms_tree($request) {
    $taxonomy = sanitize_key($request->get_param('taxonomy'));
    if (!taxonomy_exists($taxonomy) || !is_taxonomy_hierarchical($taxonomy)) {
        return new WP_Error('invalid_taxonomy', 'Invalid or non-hierarchical taxonomy.', ['status' => 400]);
    }

    $args = [
        'taxonomy'   => $taxonomy,
        'hide_empty' => false,
        'orderby'    => 'meta_value_num',
        'meta_key'   => 'menu_order',
        'order'      => 'ASC',
        'parent'     => 0,
    ];

    $terms = get_terms($args);

    $make_tree = function ($terms_list) use (&$make_tree, $taxonomy) {
        $out = [];
        foreach ($terms_list as $t) {
            $children = get_terms([
                'taxonomy'   => $taxonomy,
                'hide_empty' => false,
                'parent'     => $t->term_id,
                'orderby'    => 'meta_value_num',
                'meta_key'   => 'menu_order',
                'order'      => 'ASC',
            ]);
            $out[] = [
                'id'       => (int) $t->term_id,
                'name'     => $t->name,
                'slug'     => $t->slug,
                'parent'   => (int) $t->parent,
                'children' => !empty($children) ? $make_tree($children) : [],
            ];
        }
        return $out;
    };

    return rest_ensure_response($make_tree($terms));
}

function rcr_save_terms_order($request) {
    $taxonomy = sanitize_key($request->get_param('taxonomy'));
    $data = json_decode($request->get_body(), true);

    if (!taxonomy_exists($taxonomy) || !is_taxonomy_hierarchical($taxonomy)) {
        return new WP_Error('invalid_taxonomy', 'Invalid taxonomy.', ['status' => 400]);
    }

    if (!is_array($data)) {
        return new WP_Error('invalid_data', 'Invalid JSON payload.', ['status' => 400]);
    }

    $update_recursive = function ($items, $parent_id = 0) use (&$update_recursive, $taxonomy) {
        $order = 0;
        foreach ($items as $item) {
            if (empty($item['id'])) continue;
            $term_id = intval($item['id']);
            update_term_meta($term_id, 'menu_order', $order);
            $current = get_term($term_id, $taxonomy);
            if ($current && intval($current->parent) !== intval($parent_id)) {
                wp_update_term($term_id, $taxonomy, ['parent' => intval($parent_id)]);
            }
            if (!empty($item['children'])) {
                $update_recursive($item['children'], $term_id);
            }
            $order++;
        }
    };

    $update_recursive($data, 0);

    return rest_ensure_response(['success' => true]);
}

/**
 * Default menu_order on activation
 */
register_activation_hook(__FILE__, function () {
    $taxonomies = get_taxonomies(['hierarchical' => true, 'public' => true], 'objects');
    foreach ($taxonomies as $tax) {
        // Get terms ordered by name for a sensible default
        $terms = get_terms(['taxonomy' => $tax->name, 'hide_empty' => false, 'orderby' => 'name', 'order' => 'ASC']);
        foreach ($terms as $index => $term) {
            update_term_meta($term->term_id, 'menu_order', $index);
        }
    }
});

/**
 * Ensure admin lists respect menu_order
 */
add_filter('get_terms_orderby', function ($orderby, $args, $taxonomies) {
    $supported = array_keys(get_taxonomies(['hierarchical' => true, 'public' => true]));
    if (array_intersect($supported, (array) $taxonomies) && is_admin()) {
        global $wpdb;
        $orderby = "CAST(tm.meta_value AS UNSIGNED)";
    }
    return $orderby;
}, 10, 3);

add_filter('terms_clauses', function ($clauses, $taxonomy, $args) {
    $supported = array_keys(get_taxonomies(['hierarchical' => true, 'public' => true]));
    if (array_intersect($supported, (array) $taxonomy) && is_admin()) {
        global $wpdb;
        $clauses['join'] .= " LEFT JOIN {$wpdb->termmeta} tm ON (t.term_id = tm.term_id AND tm.meta_key = 'menu_order')";
    }
    return $clauses;
}, 10, 3);

