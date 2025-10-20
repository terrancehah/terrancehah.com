/**
 * Philosophy Sphere - Interactive 2D Network Visualization with D3.js
 * Better readability and physics-based interaction
 */

// Global variables
let svg, simulation, link, node, nodeText, zoomBehavior;
let fullGraphData = { nodes: [], links: [] };
let currentLanguage = 'en'; // 'en' or 'zh'
let currentFilter = 'all';
let width, height;
let eventListenersInitialized = false;
let currentSelectedNode = null; // Track currently selected node

/**
 * Initialize the philosophy sphere visualization
 */
function initPhilosophySphere() {
    // Get container dimensions
    const container = document.getElementById('graph-container');
    
    // Clear existing D3 SVG if any (using child selector to not remove button's SVG)
    d3.select('#graph-container > svg').remove();
    
    width = container.clientWidth;
    height = container.clientHeight;

    // Create zoom behavior
    zoomBehavior = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            svg.select('g').attr('transform', event.transform);
        });

    // Create SVG element with zoom
    svg = d3.select('#graph-container')
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .call(zoomBehavior)
        .on('click', function(event) {
            // If clicking on SVG background (not on any nodes), reset view
            if (event.target === this) {
                resetView();
            }
        });

    // Create main group for zoom/pan
    const g = svg.append('g');

    // Load data based on current language
    const dataFile = currentLanguage === 'zh' ? 'philosophy-data-zh.json' : 'philosophy-data.json';
    fetch(dataFile)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to load philosophy data');
            }
            return response.json();
        })
        .then(data => {
            // Transform data and add cross-connections
            fullGraphData = transformDataToGraph(data);
            
            // Render the graph
            renderGraph(g, fullGraphData);
            
            // Setup event listeners (only once)
            if (!eventListenersInitialized) {
                setupEventListeners();
                eventListenersInitialized = true;
            }
            
            // Build search index for autocomplete
            buildSearchIndex(fullGraphData.nodes);
            
            // Remove loading message
            const loadingMessage = document.querySelector('.loading-message');
            if (loadingMessage) {
                loadingMessage.style.display = 'none';
            }
            
            // Ensure full view is shown on initial load for both mobile and desktop
            setTimeout(() => {
                resetView();
            }, 100);
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
 */
function transformDataToGraph(data) {
    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    const ideologySet = new Set();

    // First pass: collect all ideology labels
    data.forEach(item => {
        ideologySet.add(item.ideologyLabel);
    });

    data.forEach(item => {
        // Add ideology node
        if (!nodeMap.has(item.ideologyLabel)) {
            nodes.push({
                id: item.ideologyLabel,
                label: item.ideologyLabel,
                group: 'ideology',
                description: item.description || '<p>A philosophical school of thought.</p>',
                philosopher: item.philosopher || '',
                category: item.category
            });
            nodeMap.set(item.ideologyLabel, true);
        }

        // Add related concept node ONLY if it's not already an ideology
        // and hasn't been added as a keyword yet
        if (item.relatedLabel && !nodeMap.has(item.relatedLabel) && !ideologySet.has(item.relatedLabel)) {
            // Only create keyword nodes for concepts that have descriptions
            if (item.relatedDescription) {
                nodes.push({
                    id: item.relatedLabel,
                    label: item.relatedLabel,
                    group: 'keyword',
                    description: item.relatedDescription,
                    category: item.relatedCategory || 'general'
                });
                nodeMap.set(item.relatedLabel, true);
            }
        }

        // Add link
        if (item.relatedLabel) {
            let linkColor = '#95a5a6';
            
            if (item.relation === 'influencedBy' || item.relation === 'partOf' || item.relation === 'supports') {
                linkColor = '#27ae60';
            } else if (item.relation === 'opposes' || item.relation === 'critiques') {
                linkColor = '#e74c3c';
            }

            links.push({
                source: item.ideologyLabel,
                target: item.relatedLabel,
                color: linkColor,
                relation: item.relation || 'related'
            });
        }
    });

    return { nodes, links };
}

/**
 * Render the 2D force-directed graph
 */
function renderGraph(g, graphData) {
    // Create arrow markers for directed edges
    svg.append('defs').selectAll('marker')
        .data(['support', 'oppose', 'neutral'])
        .join('marker')
        .attr('id', d => `arrow-${d}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('fill', d => {
            if (d === 'support') return '#27ae60';
            if (d === 'oppose') return '#e74c3c';
            return '#95a5a6';
        })
        .attr('d', 'M0,-5L10,0L0,5');

    // Create links
    link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(graphData.links)
        .join('line')
        .attr('stroke', d => d.color)
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 2);

    // Create node groups
    const nodeGroups = g.append('g')
        .attr('class', 'nodes')
        .selectAll('g')
        .data(graphData.nodes)
        .join('g');

    // Add circles to nodes (small, subtle background)
    nodeGroups.append('circle')
        .attr('r', d => d.group === 'ideology' ? 8 : 5)
        .attr('fill', d => d.group === 'ideology' ? '#1d3557' : '#e76f51')
        .attr('fill-opacity', 0.3)
        .attr('stroke', d => d.group === 'ideology' ? '#1d3557' : '#e76f51')
        .attr('stroke-width', 2);

    // Add text labels
    nodeText = nodeGroups.append('text')
        .attr('class', 'node-label')
        .text(d => d.label)
        .attr('font-size', d => d.group === 'ideology' ? '14px' : '11px')
        .attr('font-weight', d => d.group === 'ideology' ? 'bold' : 'normal')
        .attr('font-family', d => d.group === 'ideology' ? 'Raleway, sans-serif' : 'Lato, sans-serif')
        .attr('fill', d => d.group === 'ideology' ? '#1d3557' : '#e76f51')
        .attr('text-anchor', 'middle')
        .attr('dy', d => d.group === 'ideology' ? -15 : -10)
        .attr('pointer-events', 'none')
        .style('user-select', 'none');

    // Store node reference
    node = nodeGroups;

    // Add interaction
    nodeGroups
        .on('click', (event, d) => {
            event.stopPropagation(); // Prevent background click
            handleNodeClick(d);
        })
        .on('mouseenter', function(event, d) {
            d3.select(this).select('circle')
                .transition()
                .duration(200)
                .attr('r', d.group === 'ideology' ? 12 : 8)
                .attr('fill-opacity', 0.6);
        })
        .on('mouseleave', function(event, d) {
            d3.select(this).select('circle')
                .transition()
                .duration(200)
                .attr('r', d.group === 'ideology' ? 8 : 5)
                .attr('fill-opacity', 0.3);
        });

    // Create force simulation
    simulation = d3.forceSimulation(graphData.nodes)
        .force('link', d3.forceLink(graphData.links)
            .id(d => d.id)
            .distance(100)
            .strength(0.5))
        .force('charge', d3.forceManyBody()
            .strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide()
            .radius(d => d.group === 'ideology' ? 60 : 40))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05));

    // Pre-compute positions to avoid initial jumping
    // Run simulation silently for 300 ticks to settle positions
    simulation.stop();
    for (let i = 0; i < 300; ++i) {
        simulation.tick();
    }
    
    // Set initial positions without animation
    link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
    
    node
        .attr('transform', d => `translate(${d.x},${d.y})`);

    // Add drag behavior after simulation is created
    nodeGroups.call(dragBehavior());

    // Restart simulation with very low alpha for minimal movement
    // This keeps drag working but prevents jumping
    simulation.alpha(0.3).alphaDecay(0.05).restart();

    // Update positions on each tick
    simulation.on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node
            .attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

/**
 * Drag behavior for nodes
 */
function dragBehavior() {
    function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }

    return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
}

/**
 * Check if device is mobile
 */
function isMobile() {
    return window.innerWidth <= 768;
}

/**
 * Build searchable index for autocomplete
 */
let searchIndex = [];

function buildSearchIndex(nodes) {
    searchIndex = nodes.map(node => {
        const searchText = [
            node.label,
            node.philosopher || '',
            node.description || ''
        ].join(' ').toLowerCase();
        
        return {
            id: node.id,
            name: node.label,
            philosopher: node.philosopher || '',
            type: currentLanguage === 'zh' 
                ? (node.group === 'ideology' ? '哲学流派' : '概念')
                : (node.group === 'ideology' ? 'Philosophy' : 'Concept'),
            searchText: searchText
        };
    });
}

/**
 * Search through index with smart matching
 */
function searchAutocomplete(query) {
    if (!query || query.length < 2) return [];
    
    const lowerQuery = query.toLowerCase();
    const results = [];
    
    searchIndex.forEach(item => {
        // Check if query matches name, philosopher, or description
        if (item.searchText.includes(lowerQuery)) {
            let score = 0;
            
            // Higher score for name matches
            if (item.name.toLowerCase().includes(lowerQuery)) {
                score += 10;
                if (item.name.toLowerCase().startsWith(lowerQuery)) {
                    score += 5;
                }
            }
            
            // Medium score for philosopher matches
            if (item.philosopher && item.philosopher.toLowerCase().includes(lowerQuery)) {
                score += 7;
            }
            
            // Lower score for description matches
            if (item.searchText.includes(lowerQuery)) {
                score += 1;
            }
            
            results.push({ ...item, score });
        }
    });
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    // Return top 8 results
    return results.slice(0, 8);
}

/**
 * Display autocomplete suggestions
 */
function displayAutocomplete(results) {
    const autocompleteList = document.getElementById('autocomplete-list');
    if (!autocompleteList) return;
    
    // Clear existing items
    autocompleteList.innerHTML = '';
    
    if (results.length === 0) {
        autocompleteList.classList.remove('show');
        return;
    }
    
    results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        
        const title = document.createElement('div');
        title.className = 'autocomplete-item-title';
        title.textContent = result.name;
        
        const meta = document.createElement('div');
        meta.className = 'autocomplete-item-meta';
        meta.textContent = result.philosopher ? `${result.type} • ${result.philosopher}` : result.type;
        
        item.appendChild(title);
        item.appendChild(meta);
        
        // Click handler
        item.addEventListener('click', () => {
            focusOnNode(result.name);
            document.getElementById('search-input').value = '';
            autocompleteList.classList.remove('show');
        });
        
        autocompleteList.appendChild(item);
    });
    
    autocompleteList.classList.add('show');
}

/**
 * Focus on a node by its name
 */
function focusOnNode(nodeName) {
    const nodeData = fullGraphData.nodes.find(n => n.label === nodeName);
    if (nodeData) {
        handleNodeClick(nodeData);
    }
}

/**
 * Handle node click event
 */
function handleNodeClick(nodeData) {
    // Store the currently selected node
    currentSelectedNode = nodeData;
    
    if (isMobile()) {
        // First, do the zoom/focus animation
        centerNodeInView(nodeData);
        highlightConnections(nodeData);
        
        // Then after zoom completes (800ms), show the modal with slide-up animation
        setTimeout(() => {
            const mobileModal = document.getElementById('mobile-modal');
            const mobileNodeTitle = document.getElementById('mobile-node-title');
            const mobileNodePhilosopher = document.getElementById('mobile-node-philosopher');
            const mobileNodeDescription = document.getElementById('mobile-node-description');
            const mobileInfoContent = document.querySelector('.mobile-info-content');
            
            mobileNodeTitle.textContent = nodeData.label;
            mobileNodePhilosopher.textContent = nodeData.philosopher || '';
            mobileNodeDescription.innerHTML = nodeData.description || '<p>No description available.</p>';
            
            // Prevent body scrolling
            document.body.classList.add('modal-open');
            
            // Show modal (changes display to flex)
            mobileModal.classList.remove('hidden');
            
            // Trigger animation on next frame to ensure CSS transition works
            requestAnimationFrame(() => {
                mobileModal.classList.add('show');
                
                // Reset scroll position after modal is shown
                if (mobileInfoContent) {
                    mobileInfoContent.scrollTop = 0;
                }
            });
        }, 850); // Wait for zoom animation (800ms) + small buffer
        
        // Return early to skip the centering call at the end
        return;
    } else {
        // Use sidebar on desktop
        const infoSidebar = document.getElementById('info-sidebar');
        const nodeTitle = document.getElementById('node-title');
        const nodePhilosopher = document.getElementById('node-philosopher');
        const nodeDescription = document.getElementById('node-description');

        // Update content with smooth fade
        nodeTitle.style.opacity = '0';
        nodePhilosopher.style.opacity = '0';
        nodeDescription.style.opacity = '0';
        
        setTimeout(() => {
            nodeTitle.textContent = nodeData.label;
            nodePhilosopher.textContent = nodeData.philosopher || '';
            nodeDescription.innerHTML = nodeData.description || '<p>No description available.</p>';
            
            nodeTitle.style.opacity = '1';
            nodePhilosopher.style.opacity = '1';
            nodeDescription.style.opacity = '1';
        }, 150);
        
        // Show sidebar
        infoSidebar.classList.remove('hidden');
    }
    
    // ALWAYS center the node - this should work every time
    centerNodeInView(nodeData);
    
    // Highlight connections
    highlightConnections(nodeData);
}

/**
 * Center a node in the right portion of the view and zoom to show connections
 */
function centerNodeInView(nodeData) {
    // Get actual graph container dimensions
    const container = document.getElementById('graph-container');
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    // Find all connected nodes
    const connectedNodeIds = new Set();
    connectedNodeIds.add(nodeData.id);
    
    fullGraphData.links.forEach(link => {
        if (link.source.id === nodeData.id || link.source === nodeData.id) {
            const targetId = link.target.id || link.target;
            connectedNodeIds.add(targetId);
        }
        if (link.target.id === nodeData.id || link.target === nodeData.id) {
            const sourceId = link.source.id || link.source;
            connectedNodeIds.add(sourceId);
        }
    });
    
    // Get positions of clicked node and all connected nodes
    const connectedNodes = fullGraphData.nodes.filter(n => connectedNodeIds.has(n.id));
    
    // Calculate bounding box of the node cluster
    const bounds = {
        minX: Math.min(...connectedNodes.map(n => n.x)),
        maxX: Math.max(...connectedNodes.map(n => n.x)),
        minY: Math.min(...connectedNodes.map(n => n.y)),
        maxY: Math.max(...connectedNodes.map(n => n.y))
    };
    
    // Add padding around the cluster
    const padding = 150;
    const boundsWidth = bounds.maxX - bounds.minX + padding * 2;
    const boundsHeight = bounds.maxY - bounds.minY + padding * 2;
    const boundsCenterX = (bounds.minX + bounds.maxX) / 2;
    const boundsCenterY = (bounds.minY + bounds.maxY) / 2;
    
    // Calculate zoom scale to fit the cluster
    // Zoom in closer than before but don't exceed max zoom
    const scale = Math.min(
        containerWidth / boundsWidth,
        containerHeight / boundsHeight,
        2.5 // Max zoom level for node view
    );
    
    // Calculate translation to center the cluster
    const targetX = containerWidth / 2;
    const targetY = containerHeight / 2;
    const newTranslateX = targetX - boundsCenterX * scale;
    const newTranslateY = targetY - boundsCenterY * scale;
    
    // Stop any ongoing transitions to prevent conflicts
    svg.interrupt();
    
    // Apply the new transform with smooth transition using the stored zoom behavior
    svg.transition()
        .duration(800)
        .ease(d3.easeCubicInOut)
        .call(
            zoomBehavior.transform,
            d3.zoomIdentity
                .translate(newTranslateX, newTranslateY)
                .scale(scale)
        );
    
    console.log('Centering node:', nodeData.id, 
                '\nContainer dimensions:', containerWidth, 'x', containerHeight,
                '\nTarget center position:', targetX, targetY,
                '\nNode position:', nodeData.x, nodeData.y,
                '\nNew scale:', scale,
                '\nNew translate:', newTranslateX, newTranslateY);
}

/**
 * Highlight connected nodes and links
 */
function highlightConnections(targetNode) {
    const connectedNodeIds = new Set([targetNode.id]);
    const connectedLinkIds = new Set();

    fullGraphData.links.forEach(l => {
        if (l.source.id === targetNode.id || l.target.id === targetNode.id) {
            connectedNodeIds.add(l.source.id);
            connectedNodeIds.add(l.target.id);
            connectedLinkIds.add(`${l.source.id}-${l.target.id}`);
        }
    });

    // Fade non-connected elements
    node.style('opacity', d => connectedNodeIds.has(d.id) ? 1 : 0.2);
    nodeText.style('opacity', d => connectedNodeIds.has(d.id) ? 1 : 0.2);
    link.style('opacity', d => {
        const linkId = `${d.source.id}-${d.target.id}`;
        return connectedLinkIds.has(linkId) ? 0.8 : 0.1;
    });
}

/**
 * Reset view
 */
function resetView() {
    node.style('opacity', 1);
    nodeText.style('opacity', 1);
    link.style('opacity', 0.6);
    
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
    }
    
    // Clear selected node
    currentSelectedNode = null;
    
    // Hide sidebar
    const infoSidebar = document.getElementById('info-sidebar');
    if (infoSidebar) {
        infoSidebar.classList.add('hidden');
    }
    
    // Smooth transition to zoom out and show entire sphere
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
    
    // Calculate bounds of all nodes
    fullGraphData.nodes.forEach(node => {
        bounds.minX = Math.min(bounds.minX, node.x);
        bounds.minY = Math.min(bounds.minY, node.y);
        bounds.maxX = Math.max(bounds.maxX, node.x);
        bounds.maxY = Math.max(bounds.maxY, node.y);
    });
    
    // Add padding
    const padding = 100;
    const boundsWidth = bounds.maxX - bounds.minX + padding * 2;
    const boundsHeight = bounds.maxY - bounds.minY + padding * 2;
    const boundsCenterX = (bounds.minX + bounds.maxX) / 2;
    const boundsCenterY = (bounds.minY + bounds.maxY) / 2;
    
    // Calculate scale to fit
    const scale = Math.min(
        width / boundsWidth,
        height / boundsHeight,
        1 // Don't zoom in more than 1x
    ) * 0.9; // Additional margin
    
    // Calculate translation to center
    const translateX = width / 2 - boundsCenterX * scale;
    const translateY = height / 2 - boundsCenterY * scale;
    
    // Interrupt any ongoing transitions
    svg.interrupt();
    
    // Smoothly transition to show entire sphere
    svg.transition()
        .duration(800)
        .ease(d3.easeCubicInOut)
        .call(
            zoomBehavior.transform,
            d3.zoomIdentity
                .translate(translateX, translateY)
                .scale(scale)
        );
    
    currentFilter = 'all';
}

/**
 * Handle search input
 */
function handleSearch(searchTerm) {
    const term = searchTerm.toLowerCase().trim();

    if (term === '') {
        resetView();
        return;
    }

    node.style('opacity', d => d.label.toLowerCase().includes(term) ? 1 : 0.1);
    nodeText.style('opacity', d => d.label.toLowerCase().includes(term) ? 1 : 0.1);
    link.style('opacity', d => {
        const sourceMatches = d.source.label.toLowerCase().includes(term);
        const targetMatches = d.target.label.toLowerCase().includes(term);
        return (sourceMatches || targetMatches) ? 0.8 : 0.05;
    });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    const searchInput = document.getElementById('search-input');
    const autocompleteList = document.getElementById('autocomplete-list');
    
    if (searchInput) {
        // Handle typing in search - trigger both search highlighting and autocomplete
        searchInput.addEventListener('input', (e) => {
            const value = e.target.value;
            
            // If less than 2 characters, just do visual search
            if (value.length < 2) {
                if (autocompleteList) {
                    autocompleteList.classList.remove('show');
                }
                if (value.length === 0) {
                    resetView();
                }
                return;
            }
            
            // Visual search (highlight matching nodes)
            handleSearch(value);
            
            // Show autocomplete suggestions
            const results = searchAutocomplete(value);
            displayAutocomplete(results);
        });
        
        // Handle focus - don't show all options, only when typing
        searchInput.addEventListener('focus', (e) => {
            if (e.target.value.length >= 2) {
                const results = searchAutocomplete(e.target.value);
                displayAutocomplete(results);
            }
        });
    }
    
    // Close autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        if (autocompleteList && 
            !searchInput.contains(e.target) && 
            !autocompleteList.contains(e.target)) {
            autocompleteList.classList.remove('show');
        }
    });

    const resetButton = document.getElementById('reset-button');
    if (resetButton) {
        resetButton.addEventListener('click', resetView);
    }
    
    // Language toggle
    const languageToggle = document.getElementById('language-toggle');
    if (languageToggle) {
        languageToggle.addEventListener('click', toggleLanguage);
    }

    const closeInfoButton = document.getElementById('close-info');
    if (closeInfoButton) {
        closeInfoButton.addEventListener('click', (e) => {
            e.stopPropagation();
            resetView();
        });
    }
    
    // Mobile modal close button
    const closeMobileModal = document.getElementById('close-mobile-modal');
    if (closeMobileModal) {
        closeMobileModal.addEventListener('click', () => {
            const mobileModal = document.getElementById('mobile-modal');
            if (mobileModal) {
                // Clear selected node
                currentSelectedNode = null;
                // Remove show class for slide-down animation
                mobileModal.classList.remove('show');
                // After animation completes, hide the modal
                setTimeout(() => {
                    mobileModal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                }, 400); // Match the CSS transition duration
            }
        });
    }
    
    // Close modal when clicking backdrop
    const mobileModal = document.getElementById('mobile-modal');
    if (mobileModal) {
        mobileModal.addEventListener('click', (e) => {
            if (e.target === mobileModal) {
                // Clear selected node
                currentSelectedNode = null;
                // Remove show class for slide-down animation
                mobileModal.classList.remove('show');
                // After animation completes, hide the modal
                setTimeout(() => {
                    mobileModal.classList.add('hidden');
                    document.body.classList.remove('modal-open');
                }, 400); // Match the CSS transition duration
            }
        });
    }
}

/**
 * Toggle language between English and Chinese
 */
function toggleLanguage() {
    // Switch language
    currentLanguage = currentLanguage === 'en' ? 'zh' : 'en';
    
    // Update button text
    const langEn = document.querySelector('.lang-en');
    const langZh = document.querySelector('.lang-zh');
    if (langEn && langZh) {
        if (currentLanguage === 'zh') {
            langEn.style.display = 'none';
            langZh.style.display = 'block';
        } else {
            langEn.style.display = 'block';
            langZh.style.display = 'none';
        }
    }
    
    // Update placeholder text
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.placeholder = currentLanguage === 'zh' 
            ? '搜索哲学、概念或哲学家...' 
            : 'Search philosophies, concepts, or philosophers...';
    }
    
    // Update all UI text with data attributes
    const elementsWithLang = document.querySelectorAll('[data-en][data-zh]');
    elementsWithLang.forEach(element => {
        if (currentLanguage === 'zh') {
            element.textContent = element.getAttribute('data-zh');
        } else {
            element.textContent = element.getAttribute('data-en');
        }
    });
    
    // Clear autocomplete
    const autocompleteList = document.getElementById('autocomplete-list');
    if (autocompleteList) {
        autocompleteList.classList.remove('show');
    }
    
    // Load new language data and update graph without reloading everything
    const dataFile = currentLanguage === 'zh' ? 'philosophy-data-zh.json' : 'philosophy-data.json';
    fetch(dataFile)
        .then(response => response.json())
        .then(data => {
            // Transform new language data
            const newGraphData = transformDataToGraph(data);
            
            // Update nodes by matching with the same index position
            // Both datasets now have exactly 192 entries in the same order
            fullGraphData.nodes.forEach((node, index) => {
                if (index < newGraphData.nodes.length) {
                    const newNode = newGraphData.nodes[index];
                    // Update text properties but keep position and physics data intact
                    node.label = newNode.label;
                    node.description = newNode.description;
                    node.philosopher = newNode.philosopher || '';
                }
            });
            
            // Update visible node labels
            d3.selectAll('.node-label')
                .text(d => d.label);
            
            // Rebuild search index with new language
            buildSearchIndex(fullGraphData.nodes);
            
            // If a node is currently selected, update the sidebar/modal with new language
            if (currentSelectedNode) {
                const infoSidebar = document.getElementById('info-sidebar');
                const mobileModal = document.getElementById('mobile-modal');
                
                if (isMobile() && mobileModal && !mobileModal.classList.contains('hidden')) {
                    // Update mobile modal
                    const mobileNodeTitle = document.getElementById('mobile-node-title');
                    const mobileNodePhilosopher = document.getElementById('mobile-node-philosopher');
                    const mobileNodeDescription = document.getElementById('mobile-node-description');
                    if (mobileNodeTitle) mobileNodeTitle.textContent = currentSelectedNode.label;
                    if (mobileNodePhilosopher) mobileNodePhilosopher.textContent = currentSelectedNode.philosopher || '';
                    if (mobileNodeDescription) mobileNodeDescription.innerHTML = currentSelectedNode.description || '<p>No description available.</p>';
                } else if (!isMobile() && infoSidebar && !infoSidebar.classList.contains('hidden')) {
                    // Update desktop sidebar
                    const nodeTitle = document.getElementById('node-title');
                    const nodePhilosopher = document.getElementById('node-philosopher');
                    const nodeDescription = document.getElementById('node-description');
                    if (nodeTitle) nodeTitle.textContent = currentSelectedNode.label;
                    if (nodePhilosopher) nodePhilosopher.textContent = currentSelectedNode.philosopher || '';
                    if (nodeDescription) nodeDescription.innerHTML = currentSelectedNode.description || '<p>No description available.</p>';
                }
            }
        })
        .catch(error => {
            console.error('Error loading language data:', error);
        });
}

/**
 * Initialize when DOM is ready
 */
document.addEventListener('DOMContentLoaded', initPhilosophySphere);
