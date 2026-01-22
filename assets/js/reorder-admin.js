(function (wp, rcr_params) {
  const { useState, useEffect, useLayoutEffect, useRef } = wp.element;

  /**************************************************************************
   * Utilities
   **************************************************************************/
  function safeDestroySortable(el) {
    if (!el) return;
    try {
      if (el._sortableInstance) {
        el._sortableInstance.destroy();
        delete el._sortableInstance;
      }
    } catch (e) {
      // Silent cleanup
    }
  }

  /**************************************************************************
   * REST helpers
   **************************************************************************/
  async function fetchTree(taxonomy) {
    const url = `${rcr_params.rest_base}/terms?taxonomy=${encodeURIComponent(
      taxonomy
    )}`;
    const response = await fetch(url, {
      headers: {
        "X-WP-Nonce": rcr_params.nonce,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok)
      throw new Error(`Failed to fetch ${taxonomy}: ${response.statusText}`);
    return response.json();
  }

  async function saveTree(tree, taxonomy) {
    const url = `${rcr_params.rest_base}/save?taxonomy=${encodeURIComponent(
      taxonomy
    )}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-WP-Nonce": rcr_params.nonce,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tree),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to save ${taxonomy}: ${response.status} ${response.statusText} - ${errorText}`
      );
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
    return tree.filter((node) => {
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

    return tree.map((node) => {
      if (node.id === parentId) {
        const newChildren = node.children ? [...node.children] : [];
        if (index !== null) {
          newChildren.splice(index, 0, newNode);
        } else {
          newChildren.push(newNode);
        }
        return { ...node, children: newChildren };
      } else if (node.children) {
        return {
          ...node,
          children: addNode(node.children, parentId, newNode, index),
        };
      }
      return node;
    });
  }

  /**************************************************************************
   * Sortable initialization
   **************************************************************************/
  function attachSortableWhenReady(ulEl, onOrderChange, parentId = 0) {
    if (!ulEl) return;

    function createInstance() {
      safeDestroySortable(ulEl);

      try {
        const instance = Sortable.create(ulEl, {
          group: {
            name: "rcr-nested",
            pull: true,
            put: true,
          },
          animation: 150,
          fallbackOnBody: true,
          swapThreshold: 0.65,
          forceFallback: true,
          delay: 0,
          delayOnTouchStart: false,
          touchStartThreshold: 3,
          ghostClass: "rcr-ghost",
          chosenClass: "rcr-chosen",
          dragClass: "rcr-drag",
          emptyInsertThreshold: 50,
          sort: true,
          disabled: false,

          onStart: function (evt) {
            try {
              document.getSelection().removeAllRanges();
            } catch (e) {}

            document.querySelectorAll(".rcr-children").forEach((el) => {
              el.classList.add("rcr-drop-zone-active");
            });
          },

          onEnd: function (evt) {
            // Revert DOM changes - let React handle the rendering
            if (evt.from && evt.to) {
              if (evt.from !== evt.to) {
                evt.from.appendChild(evt.item);
              } else {
                if (evt.oldIndex < evt.newIndex) {
                  evt.from.insertBefore(
                    evt.item,
                    evt.from.children[evt.oldIndex]
                  );
                } else {
                  evt.from.insertBefore(
                    evt.item,
                    evt.from.children[evt.oldIndex + 1]
                  );
                }
              }
            }

            document.querySelectorAll(".rcr-drop-zone-active").forEach((el) => {
              el.classList.remove("rcr-drop-zone-active");
            });

            if (onOrderChange && evt.item) {
              const itemId = parseInt(evt.item.dataset.id);
              const fromParentId = evt.from.dataset.parentId
                ? parseInt(evt.from.dataset.parentId)
                : 0;
              const toParentId = evt.to.dataset.parentId
                ? parseInt(evt.to.dataset.parentId)
                : 0;
              const newIndex = evt.newIndex;

              onOrderChange(itemId, fromParentId, toParentId, newIndex);
            }
          },
        });

        ulEl._sortableInstance = instance;
        return true;
      } catch (err) {
        console.error("[RCR] Sortable.create failed", err);
        return false;
      }
    }

    ulEl.dataset.parentId = parentId;

    if (createInstance()) {
      return {
        disconnect: () => safeDestroySortable(ulEl),
      };
    }

    return {
      disconnect: () => safeDestroySortable(ulEl),
    };
  }

  /**************************************************************************
   * React components
   **************************************************************************/
  function TreeNode({ node, isHierarchical, onOrderChange, depth = 0 }) {
    const ulRef = useRef(null);

    const hasChildren = node.children && node.children.length > 0;
    const showNestedUl = isHierarchical;

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
      "li",
      {
        "data-id": node.id,
        key: node.id,
      },
      wp.element.createElement("span", { className: "rcr-label" }, node.name),
      showNestedUl &&
        wp.element.createElement(
          "ul",
          {
            className: `rcr-children ${!hasChildren ? "rcr-empty" : ""}`,
            ref: ulRef,
          },
          hasChildren &&
            node.children.map((child) =>
              wp.element.createElement(TreeNode, {
                key: child.id,
                node: child,
                isHierarchical,
                onOrderChange,
                depth: depth + 1,
              })
            )
        )
    );
  }

  function App() {
    const [availableTaxonomies] = useState(rcr_params.taxonomies || {});
    const [taxonomy, setTaxonomy] = useState(
      rcr_params.default_tax || Object.keys(availableTaxonomies)[0] || ""
    );
    const [tree, setTree] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const rootUlRef = useRef(null);
    const [sortableReady, setSortableReady] = useState(false);
    const [treeVersion, setTreeVersion] = useState(0);

    useEffect(() => {
      if (!taxonomy) return;
      setLoading(true);
      setError(null);
      setSortableReady(false);

      fetchTree(taxonomy)
        .then((data) => {
          setTree(Array.isArray(data) ? data : []);
          setTreeVersion((v) => v + 1);
          setTimeout(() => setSortableReady(true), 100);
        })
        .catch((err) => {
          console.error("[RCR] Failed to fetch terms for", taxonomy, err);
          setError(err.message);
          setTree([]);
        })
        .finally(() => setLoading(false));
    }, [taxonomy]);

    const handleOrderChange = (itemId, fromParentId, toParentId, newIndex) => {
      setTree((currentTree) => {
        const newTree = JSON.parse(JSON.stringify(currentTree));
        const nodeToMove = findNode(newTree, itemId);

        if (!nodeToMove) {
          console.error("Node not found:", itemId);
          return currentTree;
        }

        const treeWithoutNode = removeNode(newTree, itemId);
        const updatedTree = addNode(
          treeWithoutNode,
          toParentId,
          nodeToMove,
          newIndex
        );

        setTimeout(() => setTreeVersion((v) => v + 1), 0);

        return updatedTree;
      });
    };

    useLayoutEffect(() => {
      if (!rootUlRef.current || !sortableReady || tree.length === 0) {
        return;
      }

      const handle = attachSortableWhenReady(
        rootUlRef.current,
        handleOrderChange,
        0
      );

      return () => {
        if (handle) handle.disconnect();
      };
    }, [tree, sortableReady, treeVersion]);

    async function onSave() {
      setSaving(true);
      setError(null);

      try {
        const result = await saveTree(tree, taxonomy);
        const refreshed = await fetchTree(taxonomy);
        setTree(refreshed);
        setTreeVersion((v) => v + 1);
        setTimeout(() => setSortableReady(true), 100);
        alert(result.message || "Order and hierarchy saved successfully!");
      } catch (err) {
        console.error("[RCR] Save failed", err);
        setError(err.message);
        alert("Save failed: " + err.message);
      } finally {
        setSaving(false);
      }
    }

    const isHierarchical = true;

    return wp.element.createElement(
      "div",
      { className: "rcr-container" },
      wp.element.createElement(
        "div",
        { className: "rcr-taxonomy-selector" },
        wp.element.createElement(
          "label",
          { htmlFor: "rcr-tax-select" },
          "Select Taxonomy: "
        ),
        wp.element.createElement(
          "select",
          {
            id: "rcr-tax-select",
            value: taxonomy,
            onChange: (e) => setTaxonomy(e.target.value),
          },
          Object.entries(availableTaxonomies).map(([key, label]) => {
            return wp.element.createElement(
              "option",
              { key, value: key },
              label
            );
          })
        )
      ),

      error &&
        wp.element.createElement(
          "div",
          {
            className: "notice notice-error",
            style: {
              padding: "10px",
              margin: "10px 0",
              background: "#f8d7da",
              border: "1px solid #f5c6cb",
            },
          },
          error
        ),

      loading
        ? wp.element.createElement("p", null, "Loading...")
        : tree.length === 0
        ? wp.element.createElement(
            "p",
            null,
            `No terms found for ${taxonomy}. Add some in the admin.`
          )
        : wp.element.createElement(
            React.Fragment,
            null,
            wp.element.createElement(
              "div",
              {
                className: "rcr-instructions",
                style: {
                  marginBottom: "15px",
                  padding: "10px",
                  background: "#f0f6fc",
                  border: "1px solid #c3c4c7",
                  borderRadius: "4px",
                },
              },
              wp.element.createElement(
                "h3",
                { style: { margin: "0 0 8px 0" } },
                "How to reorganize:"
              ),
              wp.element.createElement(
                "ul",
                { style: { margin: "0", paddingLeft: "20px" } },
                wp.element.createElement(
                  "li",
                  null,
                  "Drag terms up/down to reorder"
                ),
                wp.element.createElement(
                  "li",
                  null,
                  "Drag terms into other terms to nest them"
                ),
                wp.element.createElement(
                  "li",
                  null,
                  "Drag nested terms to root level to make them top-level"
                ),
                wp.element.createElement(
                  "li",
                  null,
                  'Click "Save Order & Hierarchy" to apply changes'
                )
              )
            ),
            wp.element.createElement(
              "ul",
              {
                className: "rcr-tree",
                ref: rootUlRef,
                key: `tree-${treeVersion}`,
              },
              tree.map((node) =>
                wp.element.createElement(TreeNode, {
                  key: node.id,
                  node,
                  isHierarchical,
                  onOrderChange: handleOrderChange,
                })
              )
            )
          ),
      wp.element.createElement(
        "div",
        { className: "rcr-controls" },
        wp.element.createElement(
          "button",
          {
            className: "button button-primary",
            onClick: onSave,
            disabled: saving || loading || tree.length === 0,
          },
          saving ? "Saving…" : "Save Order & Hierarchy"
        )
      )
    );
  }

  document.addEventListener("DOMContentLoaded", function () {
    const root = document.getElementById("rcr-root");
    if (root) {
      wp.element.render(wp.element.createElement(App), root);
    }
  });
})(window.wp, window.rcr_params);
