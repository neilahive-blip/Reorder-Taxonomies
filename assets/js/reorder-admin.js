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
        if (!response.ok) throw new Error(`Failed to save ${taxonomy}: ${response.statusText}`);
        return response.json();
    }

    /**************************************************************************
     * Build tree from DOM (used on Save)
     **************************************************************************/
    function buildTreeFromDOM(rootUl) {
        const res = [];
        const children = rootUl ? rootUl.children : [];
        for (let i = 0; i < children.length; i++) {
            const li = children[i];
            if (!li || li.tagName !== 'LI') continue;
            const id = li.getAttribute('data-id');
            const childUl = li.querySelector(':scope > ul.rcr-children');
            const node = { id: parseInt(id, 10), children: [] };
            if (childUl) node.children = buildTreeFromDOM(childUl);
            res.push(node);
        }
        return res;
    }

    /**************************************************************************
     * Sortable initialization helper (FIXED - ensures DOM is ready)
     **************************************************************************/
    function attachSortableWhenReady(ulEl, options = {}) {
        if (!ulEl) return;
        
        let observer;
        let timeoutId;

        function createInstance() {
            safeDestroySortable(ulEl);
            
            // Double-check that we have LI elements
            const hasListItems = ulEl.querySelector('li');
            if (!hasListItems) {
                debugLog('No LI elements found in UL, skipping Sortable initialization');
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
                    
                    onStart: function(evt) {
                        try {
                            document.getSelection().removeAllRanges();
                        } catch (e) {}
                        debugLog('Drag start on', ulEl.className, 'item:', evt.item.textContent);
                    },
                    
                    onUpdate: function(evt) {
                        debugLog('Sortable updated on', ulEl.className);
                    },
                    
                    onEnd: function(evt) {
                        debugLog('Drag end on', ulEl.className, 'from:', evt.from.className, 'to:', evt.to?.className);
                    },
                    
                    ...options
                });
                
                ulEl._sortableInstance = instance;
                debugLog('Sortable successfully attached to', ulEl.className, 'with', ulEl.children.length, 'items');
                return true;
            } catch (err) {
                console.error('[RCR] Sortable.create failed', err);
                return false;
            }
        }

        function attemptInit() {
            if (ulEl.children.length > 0) {
                debugLog('UL has children, attempting Sortable initialization for', ulEl.className);
                return createInstance();
            }
            debugLog('UL has no children yet', ulEl.className);
            return false;
        }

        // Try immediately
        if (attemptInit()) {
            return {
                disconnect: () => safeDestroySortable(ulEl)
            };
        }

        // If no children yet, set up observation with multiple strategies
        debugLog('Setting up observer for', ulEl.className);
        
        // Strategy 1: MutationObserver for DOM changes
        observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    debugLog('DOM changed, checking for LIs in', ulEl.className);
                    if (attemptInit()) {
                        observer.disconnect();
                    }
                }
            });
        });
        
        observer.observe(ulEl, { 
            childList: true, 
            subtree: false 
        });

        // Strategy 2: Fallback timeout
        timeoutId = setTimeout(() => {
            debugLog('Fallback timeout reached for', ulEl.className);
            observer.disconnect();
            attemptInit();
        }, 1000);

        // Strategy 3: Also try on next animation frame (for React re-renders)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!ulEl._sortableInstance) {
                    debugLog('RAF check for', ulEl.className);
                    attemptInit();
                }
            });
        });

        return {
            disconnect: () => {
                if (observer) observer.disconnect();
                if (timeoutId) clearTimeout(timeoutId);
                safeDestroySortable(ulEl);
            }
        };
    }

    /**************************************************************************
     * React components
     **************************************************************************/
    function TreeNode({ node, isHierarchical, setTree }) {
        const ulRef = useRef(null);

        // init sortable for nested ul - use useLayoutEffect for immediate DOM access
        useLayoutEffect(() => {
            if (!ulRef.current) return;
            
            const handle = attachSortableWhenReady(ulRef.current, {
                onUpdate: (evt) => {
                    debugLog('Nested updated for parent', node.id);
                }
            });
            
            return () => {
                if (handle) handle.disconnect();
            };
        }, [ulRef.current, node.children, node.id]);

        const hasChildren = node.children && node.children.length > 0;
        const showNestedUl = isHierarchical || hasChildren;

        return wp.element.createElement(
            'li',
            { 'data-id': node.id },
            wp.element.createElement('span', { className: 'rcr-label' }, node.name),
            showNestedUl
                ? wp.element.createElement(
                    'ul',
                    { className: 'rcr-children', ref: ulRef },
                    hasChildren
                        ? node.children.map((child) =>
                            wp.element.createElement(TreeNode, { 
                                key: child.id, 
                                node: child, 
                                isHierarchical, 
                                setTree 
                            })
                        )
                        : null
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
        const rootUlRef = useRef(null);
        const [sortableReady, setSortableReady] = useState(false);

        // fetch tree on taxonomy change
        useEffect(() => {
            if (!taxonomy) return;
            setLoading(true);
            setSortableReady(false);
            fetchTree(taxonomy)
                .then((data) => {
                    setTree(Array.isArray(data) ? data : []);
                    // Small delay to ensure DOM is updated before initializing Sortable
                    setTimeout(() => setSortableReady(true), 100);
                })
                .catch((err) => {
                    console.error('[RCR] Failed to fetch terms for', taxonomy, err);
                    setTree([]);
                    setSortableReady(false);
                })
                .finally(() => setLoading(false));
        }, [taxonomy]);

        // Attach root Sortable - use useLayoutEffect and proper dependencies
        useLayoutEffect(() => {
            if (!rootUlRef.current || !sortableReady || tree.length === 0) {
                return;
            }
            
            debugLog('Initializing root Sortable, tree length:', tree.length, 'UL children:', rootUlRef.current.children.length);
            
            const handle = attachSortableWhenReady(rootUlRef.current, {
                onUpdate: (evt) => {
                    debugLog('Root order updated');
                },
                onAdd: (evt) => {
                    debugLog('Item added to root');
                },
                onRemove: (evt) => {
                    debugLog('Item removed from root');
                }
            });
            
            return () => {
                debugLog('Cleaning up root sortable');
                if (handle) handle.disconnect();
            };
        }, [taxonomy, tree, sortableReady]); // Added sortableReady as dependency

        // Re-initialize Sortable when tree data changes after save
        useEffect(() => {
            if (!saving && tree.length > 0) {
                // Small delay to ensure DOM is updated with new tree data
                const timer = setTimeout(() => {
                    setSortableReady(true);
                }, 50);
                return () => clearTimeout(timer);
            }
        }, [saving, tree]);

        async function onSave() {
            setSaving(true);
            try {
                const rootUl = rootUlRef.current;
                if (!rootUl) throw new Error('Root UL not found');
                const payload = buildTreeFromDOM(rootUl);
                await saveTree(payload, taxonomy);
                const refreshed = await fetchTree(taxonomy);
                setTree(refreshed);
                alert('Order saved successfully!');
                debugLog(`${taxonomy} order saved.`);
            } catch (err) {
                console.error('[RCR] Save failed', err);
                alert('Save failed. Check console for details.');
            } finally {
                setSaving(false);
            }
        }

        const isHierarchical = availableTaxonomies[taxonomy] && typeof availableTaxonomies[taxonomy] === 'object'
            ? availableTaxonomies[taxonomy].hierarchical
            : true;

        return wp.element.createElement('div', { className: 'rcr-container' },
            wp.element.createElement('div', { className: 'rcr-taxonomy-selector' },
                wp.element.createElement('label', { htmlFor: 'rcr-tax-select' }, 'Select Taxonomy: '),
                wp.element.createElement('select', {
                    id: 'rcr-tax-select',
                    value: taxonomy,
                    onChange: (e) => setTaxonomy(e.target.value)
                },
                    Object.entries(availableTaxonomies).map(([key, infoOrLabel]) => {
                        const label = typeof infoOrLabel === 'string' ? infoOrLabel : (infoOrLabel.label || key);
                        return wp.element.createElement('option', { key, value: key }, label);
                    })
                )
            ),
            loading
                ? wp.element.createElement('p', null, 'Loading...')
                : tree.length === 0
                    ? wp.element.createElement('p', null, `No terms found for ${taxonomy}. Add some in the admin.`)
                    : wp.element.createElement(
                        React.Fragment,
                        null,
                        wp.element.createElement('p', { style: { marginBottom: '15px', fontStyle: 'italic' } }, 
                            'Drag and drop terms to reorder. All levels are draggable.'
                        ),
                        !sortableReady && wp.element.createElement('p', { style: { color: '#d63638' } }, 
                            'Initializing drag and drop...'
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
                }, saving ? 'Saving…' : 'Save Order')
            )
        );
    }

    // Render when DOM ready
    document.addEventListener('DOMContentLoaded', function () {
        const root = document.getElementById('rcr-root');
        if (root) {
            wp.element.render(wp.element.createElement(App), root);
            debugLog('RCR App initialized');
        }
    });
})(window.wp, window.rcr_params);
