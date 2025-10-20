/**
 * Philosophy Sphere - Interactive 3D Visualization
 * Displays philosophical ideologies and their relationships in a 3D force-directed graph
 */

// Global variables
let graphInstance = null;
let fullGraphData = { nodes: [], links: [] };
let currentFilter = 'all';

/**
 * Initialize the philosophy sphere visualization
 */
function initPhilosophySphere() {
    // Load the philosophy data
    fetch('philosophy-data.json')
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to load philosophy data');
            }
            return response.json();
        })
        .then(data => {
            // Transform raw data into graph format
            fullGraphData = transformDataToGraph(data);
            
            // Render the 3D graph
            renderGraph(fullGraphData);
            
            // Setup event listeners
            setupEventListeners();
            
            // Remove loading message
            const loadingMessage = document.querySelector('.loading-message');
            if (loadingMessage) {
                loadingMessage.style.display = 'none';
            }
        })
        .catch(error => {
            console.error('Error loading philosophy data:', error);
            const loadingMessage = document.querySelector('.loading-message');
            if (loadingMessage) {
                loadingMessage.textContent = 'Error loading data. Please refresh the page.';
                loadingMessage.style.color = '#e74c3c';
            }
        });
}

/**
 * Transform raw data into graph format with nodes and links
 * @param {Array} data - Raw philosophy data
 * @returns {Object} Graph data with nodes and links
 */
function transformDataToGraph(data) {
    const nodes = [];
    const links = [];
    const nodeMap = new Map();

    data.forEach(item => {
        // Add ideology node if not exists
        if (!nodeMap.has(item.ideologyLabel)) {
            nodes.push({
                id: item.ideologyLabel,
                group: 'ideology',
                size: 12,
                description: item.description || 'A philosophical ideology',
                category: item.category || 'general'
            });
            nodeMap.set(item.ideologyLabel, true);
        }

        // Add related concept/keyword node if not exists
        if (item.relatedLabel && !nodeMap.has(item.relatedLabel)) {
            nodes.push({
                id: item.relatedLabel,
                group: 'keyword',
                size: 6,
                description: item.relatedDescription || 'A related concept',
                category: item.relatedCategory || 'general'
            });
            nodeMap.set(item.relatedLabel, true);
        }

        // Add link/relationship if exists
        if (item.relatedLabel) {
            let linkColor = '#95a5a6'; // Default gray
            let linkWidth = 1;

            // Determine link color based on relationship type
            if (item.relation === 'influencedBy' || item.relation === 'partOf' || item.relation === 'supports') {
                linkColor = '#27ae60'; // Green for influence/support
                linkWidth = 2;
            } else if (item.relation === 'opposes' || item.relation === 'critiques') {
                linkColor = '#e74c3c'; // Red for opposition
                linkWidth = 2;
            }

            links.push({
                source: item.ideologyLabel,
                target: item.relatedLabel,
                color: linkColor,
                width: linkWidth,
                relation: item.relation || 'related'
            });
        }
    });

    return { nodes, links };
}

/**
 * Render the 3D force-directed graph
 * @param {Object} graphData - Graph data with nodes and links
 */
function renderGraph(graphData) {
    const container = document.getElementById('graph-container');
    
    // Create 3D force graph
    graphInstance = ForceGraph3D()(container)
        .graphData(graphData)
        .nodeLabel('id')
        .nodeRelSize(0.1) // Make default nodes very small (almost invisible)
        .nodeOpacity(0.1) // Make sphere nodes nearly transparent
        .linkColor('color')
        .linkWidth('width')
        .linkOpacity(0.6)
        .backgroundColor('#f8f9fa')
        .enableNodeDrag(true)
        .enableNavigationControls(true)
        .showNavInfo(false)
        .onNodeClick(handleNodeClick)
        .onNodeHover(handleNodeHover);

    // Use text as the primary visual element (no sphere nodes)
    if (typeof SpriteText !== 'undefined') {
        graphInstance
            .nodeThreeObject(node => {
                const sprite = new SpriteText(node.id);
                sprite.material.depthWrite = false;
                
                // Style based on node type
                if (node.group === 'ideology') {
                    sprite.color = '#1d3557'; // Dark blue for ideologies
                    sprite.textHeight = 10;
                    sprite.fontFace = 'Raleway, sans-serif';
                    sprite.fontWeight = 'bold';
                } else {
                    sprite.color = '#e76f51'; // Orange-red for keywords
                    sprite.textHeight = 6;
                    sprite.fontFace = 'Lato, sans-serif';
                    sprite.fontWeight = 'normal';
                }
                
                sprite.backgroundColor = 'rgba(255, 255, 255, 0.8)';
                sprite.padding = 2;
                sprite.borderRadius = 3;
                
                return sprite;
            })
            .nodeThreeObjectExtend(false); // Replace node completely with text
    }

    // Set initial camera position for better view
    graphInstance.cameraPosition({ z: 400 });
}

/**
 * Handle node click event
 * @param {Object} node - Clicked node
 */
function handleNodeClick(node) {
    const infoPanel = document.getElementById('info-panel');
    const nodeTitle = document.getElementById('node-title');
    const nodeDescription = document.getElementById('node-description');

    // Update info panel content
    nodeTitle.textContent = node.id;
    nodeDescription.textContent = node.description || 'No description available.';

    // Show info panel
    infoPanel.classList.remove('hidden');

    // Highlight the clicked node and its connections
    highlightNode(node);
}

/**
 * Handle node hover event
 * @param {Object} node - Hovered node
 */
function handleNodeHover(node) {
    // Change cursor on hover
    document.body.style.cursor = node ? 'pointer' : 'default';
}

/**
 * Highlight a specific node and its connections
 * @param {Object} targetNode - Node to highlight
 */
function highlightNode(targetNode) {
    if (!targetNode || !graphInstance) return;

    const connectedNodeIds = new Set();
    const connectedLinkIds = new Set();

    // Find all connected nodes and links
    fullGraphData.links.forEach(link => {
        if (link.source.id === targetNode.id || link.target.id === targetNode.id) {
            connectedNodeIds.add(link.source.id);
            connectedNodeIds.add(link.target.id);
            connectedLinkIds.add(`${link.source.id}-${link.target.id}`);
        }
    });

    // Update node opacity
    graphInstance.nodeOpacity(node => {
        return connectedNodeIds.has(node.id) ? 1 : 0.2;
    });

    // Update link opacity
    graphInstance.linkOpacity(link => {
        const linkId = `${link.source.id}-${link.target.id}`;
        return connectedLinkIds.has(linkId) ? 0.8 : 0.1;
    });
}

/**
 * Reset the view to show all nodes equally
 */
function resetView() {
    if (!graphInstance) return;

    // Reset all opacities
    graphInstance.nodeOpacity(1);
    graphInstance.linkOpacity(0.6);

    // Reset camera position
    graphInstance.cameraPosition({ z: 300 }, 1000);

    // Clear search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
    }

    currentFilter = 'all';
}

/**
 * Filter graph to show only idealism-related nodes
 */
function filterIdealism() {
    if (!graphInstance) return;

    currentFilter = 'idealism';

    graphInstance.nodeOpacity(node => {
        const isIdealism = node.category === 'idealism' || 
                          node.id.toLowerCase().includes('ideal') ||
                          node.id.toLowerCase().includes('transcendent');
        return isIdealism ? 1 : 0.15;
    });

    graphInstance.linkOpacity(link => {
        const sourceNode = fullGraphData.nodes.find(n => n.id === link.source.id);
        const targetNode = fullGraphData.nodes.find(n => n.id === link.target.id);
        const isIdealism = (sourceNode?.category === 'idealism' || targetNode?.category === 'idealism');
        return isIdealism ? 0.8 : 0.1;
    });
}

/**
 * Show all nodes in the graph
 */
function showAll() {
    resetView();
}

/**
 * Handle search input
 * @param {string} searchTerm - Search term entered by user
 */
function handleSearch(searchTerm) {
    if (!graphInstance) return;

    const term = searchTerm.toLowerCase().trim();

    if (term === '') {
        // If search is empty, reset to current filter state
        if (currentFilter === 'idealism') {
            filterIdealism();
        } else {
            resetView();
        }
        return;
    }

    // Filter nodes based on search term
    graphInstance.nodeOpacity(node => {
        return node.id.toLowerCase().includes(term) ? 1 : 0.1;
    });

    // Filter links based on connected nodes
    graphInstance.linkOpacity(link => {
        const sourceMatches = link.source.id.toLowerCase().includes(term);
        const targetMatches = link.target.id.toLowerCase().includes(term);
        return (sourceMatches || targetMatches) ? 0.8 : 0.05;
    });
}

/**
 * Setup event listeners for user interactions
 */
function setupEventListeners() {
    // Search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
    }

    // Reset button
    const resetButton = document.getElementById('reset-button');
    if (resetButton) {
        resetButton.addEventListener('click', resetView);
    }

    // Idealism filter button
    const idealismFilter = document.getElementById('idealism-filter');
    if (idealismFilter) {
        idealismFilter.addEventListener('click', filterIdealism);
    }

    // Show all button
    const showAllButton = document.getElementById('show-all');
    if (showAllButton) {
        showAllButton.addEventListener('click', showAll);
    }

    // Close info panel button
    const closeInfoButton = document.getElementById('close-info');
    if (closeInfoButton) {
        closeInfoButton.addEventListener('click', () => {
            const infoPanel = document.getElementById('info-panel');
            infoPanel.classList.add('hidden');
            resetView();
        });
    }

    // Close info panel when clicking outside
    const infoPanel = document.getElementById('info-panel');
    if (infoPanel) {
        document.addEventListener('click', (e) => {
            if (!infoPanel.contains(e.target) && 
                !e.target.closest('#graph-container') &&
                !infoPanel.classList.contains('hidden')) {
                infoPanel.classList.add('hidden');
                resetView();
            }
        });
    }
}

// Initialize when DOM and all scripts are ready
function startWhenReady() {
    // Check if all required libraries are loaded
    if (typeof THREE !== 'undefined' && 
        typeof ForceGraph3D !== 'undefined' && 
        typeof SpriteText !== 'undefined') {
        initPhilosophySphere();
    } else {
        // Wait a bit and try again
        setTimeout(startWhenReady, 100);
    }
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWhenReady);
} else {
    startWhenReady();
}
