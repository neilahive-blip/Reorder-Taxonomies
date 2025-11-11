(function (wp, rcr_params) {
    const { useState, useEffect, useLayoutEffect, useRef } = wp.element;

    /**************************************************************************
     * Utilities
     **************************************************************************/
    function debugLog(...args) {
        if (window.console && window.console.log) {
            console.log('[RCR]', ...args);
        }
    }

    function safeDestroySortable(el) {
        if (!el) return;
        try {
            if (el._sortableInstance) {
                debugLog('Destroying sortable on', el);
                el._sortableInstance.destroy();
                delete el._sortableInstance;
            }
        } catch (e) {
            console.warn('[RCR] error destroying sortable', e);
        }
    }

    /**************************************************************************
     * REST helpers
     **************************************************************************/
    async function fetchTree(taxonomy) {
        const url = `${rcr_params.rest_base}/terms?taxonomy=${encodeURIComponent(taxonomy)}`;
        const response = await fetch(url, {
            headers: {
                'X-WP-Nonce': rcr_params.nonce,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) throw new Error(`Failed to fetch ${taxonomy}: ${response.statusText}`);
        return response.json();
    }

    async function saveTree(tree, taxonomy) {
        const url = `${rcr_params.rest_base}/save?taxonomy=${encodeURIComponent(taxonomy)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-WP-Nonce': rcr_params.nonce,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(tree)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to save ${taxonomy}: ${response.status} ${response.statusText} - ${errorText}`);
        }
        
        const result = await response.json();
        return result;
    }

    /**************************************************************************
     * Build tree from DOM (FIXED - properly handles hierarchy)
     **************************************************************************/
    function buildTreeFromDOM(rootUl) {
        const res = [];
        const children = rootUl ? Array.from(rootUl.children) : [];
        
        for (let i = 0; i < children.length; i++) {
            const li = children[i];
            if (!li || li.tagName !== 'LI') continue;
            
            const id = li.getAttribute('data-id');
            if (!id) continue;
            
            const childUl = li.querySelector(':scope > ul.rcr-children');
            const node = { 
                id: parseInt(id, 10), 
                children: [] 
            };
            
            // Only process children if the UL has LI elements
            if (childUl) {
                const childLis = Array.from(childUl.children).filter(child => child.tagName === 'LI');
                if (childLis.length > 0) {
                    node.children = buildTreeFromDOM(childUl);
                }
            }
            
            res.push(node);
        }
        return res;
    }

    /**************************************************************************
     * Sortable initialization helper (FIXED for empty containers)
     **************************************************************************/
    function attachSortableWhenReady(ulEl, options = {}) {
        if (!ulEl) return;
        
        let observer;
        let timeoutId;

        function createInstance() {
            safeDestroySortable(ulEl);
            
            // Check if we have LI elements or if this is an empty container that should accept drops
            const hasListItems = ulEl.querySelector('li');
            const isChildContainer = ulEl.classList.contains('rcr-children');
            
            if (!hasListItems && !isChildContainer) {
                debugLog('No LI elements found in non-child UL, skipping Sortable initialization');
                return false;
            }
            
            try {
                const instance = Sortable.create(ulEl, {
                    group: {
                        name: 'rcr-nested',
                        pull: true,
                        put: true
                    },
                    animation: 150,
                    fallbackOnBody: true,
                    swapThreshold: 0.65,
                    forceFallback: true,
                    delay: 0,
                    delayOnTouchStart: false,
                    touchStartThreshold: 3,
                    ghostClass: 'rcr-ghost',
                    chosenClass: 'rcr-chosen',
                    dragClass: 'rcr-drag',
                    // CRITICAL: Allow putting items into empty lists
                    emptyInsertThreshold: 50,
                    
                    onStart: function(evt) {
                        try {
                            document.getSelection().removeAllRanges();
                        } catch (e) {}
                        debugLog('Drag start on', ulEl.className, 'item:', evt.item.textContent);
                        
                        // Add visual indicator for ALL child containers (even empty ones)
                        document.querySelectorAll('.rcr-children').forEach(el => {
                            el.classList.add('rcr-drop-zone-active');
                        });
                    },
                    
                    onAdd: function(evt) {
                        debugLog('Item added to', ulEl.className);
                        // If this was an empty container, ensure it stays visible
                        ulEl.classList.remove('rcr-empty');
                    },
                    
                    onRemove: function(evt) {
                        debugLog('Item removed from', ulEl.className);
                        // If container becomes empty, ensure it stays as a drop target
                        if (ulEl.children.length === 0 && ulEl.classList.contains('rcr-children')) {
                            ulEl.classList.add('rcr-empty');
                        }
                    },
                    
                    onEnd: function(evt) {
                        debugLog('Drag ended');
                        // Remove visual indicators
                        document.querySelectorAll('.rcr-drop-zone-active').forEach(el => {
                            el.classList.remove('rcr-drop-zone-active');
                        });
                    },
                    
                    ...options
                });
                
                ulEl._sortableInstance = instance;
                debugLog('Sortable successfully attached to', ulEl.className);
                return true;
            } catch (err) {
                console.error('[RCR] Sortable.create failed', err);
                return false;
            }
        }

        function attemptInit() {
            return createInstance();
        }

        // Try immediately
        if (attemptInit()) {
            return {
                disconnect: () => safeDestroySortable(ulEl)
            };
        }

        return {
            disconnect: () => safeDestroySortable(ulEl)
        };
    }

    /**************************************************************************
     * React components (FIXED - ensures empty containers are always available)
     **************************************************************************/
    function TreeNode({ node, isHierarchical, setTree }) {
        const ulRef = useRef(null);

        // Always show nested UL for hierarchical taxonomies, even if empty
        const hasChildren = node.children && node.children.length > 0;
        const showNestedUl = isHierarchical; // Always show for hierarchical taxonomies

        // init sortable for nested ul
        useLayoutEffect(() => {
            if (!ulRef.current || !showNestedUl) return;
            
            const handle = attachSortableWhenReady(ulRef.current);
            
            return () => {
                if (handle) handle.disconnect();
            };
        }, [ulRef.current, showNestedUl, node.id]);

        return wp.element.createElement(
            'li',
            { 'data-id': node.id },
            wp.element.createElement('span', { className: 'rcr-label' }, node.name),
            showNestedUl
                ? wp.element.createElement(
                    'ul',
                    { 
                        className: `rcr-children ${!hasChildren ? 'rcr-empty' : ''}`,
                        ref: ulRef 
                    },
                    hasChildren && node.children.map((child) =>
                        wp.element.createElement(TreeNode, { 
                            key: child.id, 
                            node: child, 
                            isHierarchical, 
                            setTree 
                        })
                    )
                )
                : null
        );
    }

    function App() {
        const [availableTaxonomies] = useState(rcr_params.taxonomies || {});
        const [taxonomy, setTaxonomy] = useState(rcr_params.default_tax || Object.keys(availableTaxonomies)[0] || '');
        const [tree, setTree] = useState([]);
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [error, setError] = useState(null);
        const rootUlRef = useRef(null);
        const [sortableReady, setSortableReady] = useState(false);

        // fetch tree on taxonomy change
        useEffect(() => {
            if (!taxonomy) return;
            setLoading(true);
            setError(null);
            setSortableReady(false);
            
            fetchTree(taxonomy)
                .then((data) => {
                    setTree(Array.isArray(data) ? data : []);
                    setTimeout(() => setSortableReady(true), 200);
                })
                .catch((err) => {
                    console.error('[RCR] Failed to fetch terms for', taxonomy, err);
                    setError(err.message);
                    setTree([]);
                })
                .finally(() => setLoading(false));
        }, [taxonomy]);

        // Attach root Sortable
        useLayoutEffect(() => {
            if (!rootUlRef.current || !sortableReady || tree.length === 0) {
                return;
            }
            
            debugLog('Initializing root Sortable');
            const handle = attachSortableWhenReady(rootUlRef.current);
            
            return () => {
                if (handle) handle.disconnect();
            };
        }, [taxonomy, tree, sortableReady]);

        async function onSave() {
            setSaving(true);
            setError(null);
            
            try {
                const rootUl = rootUlRef.current;
                if (!rootUl) throw new Error('Root UL not found');
                
                debugLog('Building tree from DOM...');
                const payload = buildTreeFromDOM(rootUl);
                debugLog('Payload to save:', payload);
                
                const result = await saveTree(payload, taxonomy);
                debugLog('Save result:', result);
                
                // Refresh the tree to get the updated structure from server
                const refreshed = await fetchTree(taxonomy);
                setTree(refreshed);
                
                // Re-initialize sortable after refresh
                setTimeout(() => setSortableReady(true), 100);
                
                alert(result.message || 'Order and hierarchy saved successfully!');
                
            } catch (err) {
                console.error('[RCR] Save failed', err);
                setError(err.message);
                alert('Save failed: ' + err.message);
            } finally {
                setSaving(false);
            }
        }

        const isHierarchical = true; // Since we're only dealing with hierarchical taxonomies

        return wp.element.createElement('div', { className: 'rcr-container' },
            wp.element.createElement('div', { className: 'rcr-taxonomy-selector' },
                wp.element.createElement('label', { htmlFor: 'rcr-tax-select' }, 'Select Taxonomy: '),
                wp.element.createElement('select', {
                    id: 'rcr-tax-select',
                    value: taxonomy,
                    onChange: (e) => setTaxonomy(e.target.value)
                },
                    Object.entries(availableTaxonomies).map(([key, label]) => {
                        return wp.element.createElement('option', { key, value: key }, label);
                    })
                )
            ),
            
            error && wp.element.createElement('div', { 
                className: 'notice notice-error', 
                style: { padding: '10px', margin: '10px 0', background: '#f8d7da', border: '1px solid #f5c6cb' } 
            }, error),
            
            loading
                ? wp.element.createElement('p', null, 'Loading...')
                : tree.length === 0
                    ? wp.element.createElement('p', null, `No terms found for ${taxonomy}. Add some in the admin.`)
                    : wp.element.createElement(
                        React.Fragment,
                        null,
                        wp.element.createElement('div', { 
                            className: 'rcr-instructions',
                            style: { 
                                marginBottom: '15px', 
                                padding: '10px',
                                background: '#f0f6fc',
                                border: '1px solid #c3c4c7',
                                borderRadius: '4px'
                            } 
                        }, 
                            wp.element.createElement('h3', { style: { margin: '0 0 8px 0' } }, 'How to reorganize:'),
                            wp.element.createElement('ul', { style: { margin: '0', paddingLeft: '20px' } },
                                wp.element.createElement('li', null, 'Drag terms up/down to reorder'),
                                wp.element.createElement('li', null, 'Drag terms into other terms to nest them'),
                                wp.element.createElement('li', null, 'Drag nested terms to root level to make them top-level'),
                                wp.element.createElement('li', null, 'Empty term containers will highlight as drop zones')
                            )
                        ),
                        wp.element.createElement('ul', { 
                            className: 'rcr-tree', 
                            ref: rootUlRef 
                        },
                            tree.map((node) => 
                                wp.element.createElement(TreeNode, { 
                                    key: node.id, 
                                    node, 
                                    isHierarchical, 
                                    setTree 
                                })
                            )
                        )
                    ),
            wp.element.createElement('div', { className: 'rcr-controls' },
                wp.element.createElement('button', {
                    className: 'button button-primary',
                    onClick: onSave,
                    disabled: saving || loading || tree.length === 0
                }, saving ? 'Saving…' : 'Save Order & Hierarchy')
            )
        );
    }

    // Render when DOM ready
    document.addEventListener('DOMContentLoaded', function () {
        const root = document.getElementById('rcr-root');
        if (root) {
            wp.element.render(wp.element.createElement(App), root);
            debugLog('RCR App initialized with fixed hierarchy support');
        }
    });
})(window.wp, window.rcr_params);
