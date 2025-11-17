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
     * Tree management utilities
     **************************************************************************/
    
    // Find a node in the tree by ID
    function findNode(tree, id) {
        for (const node of tree) {
            if (node.id === id) return node;
            if (node.children) {
                const found = findNode(node.children, id);
                if (found) return found;
            }
        }
        return null;
    }

    // Remove a node from the tree by ID
    function removeNode(tree, id) {
        return tree.filter(node => {
            if (node.id === id) return false;
            if (node.children) {
                node.children = removeNode(node.children, id);
            }
            return true;
        });
    }

    // Add a node to a specific parent
    function addNode(tree, parentId, newNode, index = null) {
        if (parentId === 0) {
            // Add to root
            const newTree = [...tree];
            if (index !== null) {
                newTree.splice(index, 0, newNode);
            } else {
                newTree.push(newNode);
            }
            return newTree;
        }

        return tree.map(node => {
            if (node.id === parentId) {
                const newChildren = node.children ? [...node.children] : [];
                if (index !== null) {
                    newChildren.splice(index, 0, newNode);
                } else {
                    newChildren.push(newNode);
                }
                return { ...node, children: newChildren };
            } else if (node.children) {
                return { ...node, children: addNode(node.children, parentId, newNode, index) };
            }
            return node;
        });
    }

    /**************************************************************************
     * Sortable initialization (FIXED - prevents React DOM conflicts)
     **************************************************************************/
    function attachSortableWhenReady(ulEl, onOrderChange, parentId = 0) {
        if (!ulEl) return;
        
        function createInstance() {
            safeDestroySortable(ulEl);
            
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
                    emptyInsertThreshold: 50,
                    
                    // CRITICAL: Prevent Sortable from modifying DOM during drag
                    sort: true,
                    disabled: false,
                    
                    onStart: function(evt) {
                        try {
                            document.getSelection().removeAllRanges();
                        } catch (e) {}
                        debugLog('Drag start on', ulEl.className);
                        
                        document.querySelectorAll('.rcr-children').forEach(el => {
                            el.classList.add('rcr-drop-zone-active');
                        });
                    },
                    
                    onEnd: function(evt) {
                        debugLog('Drag ended', {
                            itemId: evt.item.dataset.id,
                            from: evt.from.dataset.parentId || 'root',
                            to: evt.to.dataset.parentId || 'root',
                            oldIndex: evt.oldIndex,
                            newIndex: evt.newIndex
                        });

                        // CRITICAL: Revert DOM changes - let React handle the rendering
                        if (evt.from && evt.to) {
                            if (evt.from !== evt.to) {
                                // Moved between containers - revert DOM
                                evt.from.appendChild(evt.item);
                            } else {
                                // Moved within same container - revert DOM
                                if (evt.oldIndex < evt.newIndex) {
                                    evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex]);
                                } else {
                                    evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex + 1]);
                                }
                            }
                        }

                        // Remove visual indicators
                        document.querySelectorAll('.rcr-drop-zone-active').forEach(el => {
                            el.classList.remove('rcr-drop-zone-active');
                        });

                        // Notify parent component about the change - React will re-render
                        if (onOrderChange && evt.item) {
                            const itemId = parseInt(evt.item.dataset.id);
                            const fromParentId = evt.from.dataset.parentId ? parseInt(evt.from.dataset.parentId) : 0;
                            const toParentId = evt.to.dataset.parentId ? parseInt(evt.to.dataset.parentId) : 0;
                            const newIndex = evt.newIndex;
                            
                            onOrderChange(itemId, fromParentId, toParentId, newIndex);
                        }
                    }
                });
                
                ulEl._sortableInstance = instance;
                debugLog('Sortable attached to', ulEl.className);
                return true;
            } catch (err) {
                console.error('[RCR] Sortable.create failed', err);
                return false;
            }
        }

        // Set parent ID for reference
        ulEl.dataset.parentId = parentId;

        // Try initialization
        if (createInstance()) {
            return {
                disconnect: () => safeDestroySortable(ulEl)
            };
        }

        return {
            disconnect: () => safeDestroySortable(ulEl)
        };
    }

    /**************************************************************************
     * React components (FIXED - uses keys properly and prevents DOM conflicts)
     **************************************************************************/
    function TreeNode({ node, isHierarchical, onOrderChange, depth = 0 }) {
        const ulRef = useRef(null);

        const hasChildren = node.children && node.children.length > 0;
        const showNestedUl = isHierarchical;

        // Initialize sortable for this level
        useLayoutEffect(() => {
            if (!ulRef.current || !showNestedUl) return;
            
            const handle = attachSortableWhenReady(
                ulRef.current, 
                onOrderChange,
                node.id
            );
            
            return () => {
                if (handle) handle.disconnect();
            };
        }, [ulRef.current, showNestedUl, node.id, onOrderChange, node.children]);

        return wp.element.createElement(
            'li',
            { 
                'data-id': node.id,
                key: node.id // CRITICAL: Ensure stable keys
            },
            wp.element.createElement('span', { className: 'rcr-label' }, node.name),
            showNestedUl && wp.element.createElement(
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
                        onOrderChange,
                        depth: depth + 1
                    })
                )
            )
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
        const [treeVersion, setTreeVersion] = useState(0); // Force re-renders

        // Fetch tree on taxonomy change
        useEffect(() => {
            if (!taxonomy) return;
            setLoading(true);
            setError(null);
            setSortableReady(false);
            
            fetchTree(taxonomy)
                .then((data) => {
                    setTree(Array.isArray(data) ? data : []);
                    setTreeVersion(v => v + 1); // Force re-render
                    setTimeout(() => setSortableReady(true), 100);
                })
                .catch((err) => {
                    console.error('[RCR] Failed to fetch terms for', taxonomy, err);
                    setError(err.message);
                    setTree([]);
                })
                .finally(() => setLoading(false));
        }, [taxonomy]);

        // Handle order changes from Sortable
        const handleOrderChange = (itemId, fromParentId, toParentId, newIndex) => {
            debugLog('Order change:', { itemId, fromParentId, toParentId, newIndex });
            
            setTree(currentTree => {
                // Create a deep copy of the tree
                const newTree = JSON.parse(JSON.stringify(currentTree));
                
                // Find the node being moved
                const nodeToMove = findNode(newTree, itemId);
                if (!nodeToMove) {
                    console.error('Node not found:', itemId);
                    return currentTree;
                }
                
                // Remove node from old position
                const treeWithoutNode = removeNode(newTree, itemId);
                
                // Add node to new position
                const updatedTree = addNode(treeWithoutNode, toParentId, nodeToMove, newIndex);
                
                // Force re-render by updating version
                setTimeout(() => setTreeVersion(v => v + 1), 0);
                
                return updatedTree;
            });
        };

        // Initialize root sortable
        useLayoutEffect(() => {
            if (!rootUlRef.current || !sortableReady || tree.length === 0) {
                return;
            }
            
            debugLog('Initializing root Sortable');
            const handle = attachSortableWhenReady(
                rootUlRef.current, 
                handleOrderChange,
                0
            );
            
            return () => {
                if (handle) handle.disconnect();
            };
        }, [tree, sortableReady, treeVersion]); // Add treeVersion dependency

        // Save using React state
        async function onSave() {
            setSaving(true);
            setError(null);
            
            try {
                debugLog('Saving tree from state:', tree);
                
                const result = await saveTree(tree, taxonomy);
                debugLog('Save result:', result);
                
                // Refresh the tree to get the updated structure from server
                const refreshed = await fetchTree(taxonomy);
                setTree(refreshed);
                setTreeVersion(v => v + 1); // Force re-render
                
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

        const isHierarchical = true;

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
                                wp.element.createElement('li', null, 'Click "Save Order & Hierarchy" to apply changes')
                            )
                        ),
                        wp.element.createElement('ul', { 
                            className: 'rcr-tree', 
                            ref: rootUlRef,
                            key: `tree-${treeVersion}` // CRITICAL: Force re-render when tree changes
                        },
                            tree.map((node) => 
                                wp.element.createElement(TreeNode, { 
                                    key: node.id, 
                                    node, 
                                    isHierarchical, 
                                    onOrderChange: handleOrderChange
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
            debugLog('RCR App initialized with state management');
        }
    });
})(window.wp, window.rcr_params);
