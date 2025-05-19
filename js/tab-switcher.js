// Tab Switching Functionality
// This script handles the tabbed interface for career roadmap phases
document.addEventListener('DOMContentLoaded', function() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', function() {
      // Remove active class from all buttons and panes
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanes.forEach(pane => pane.classList.remove('active'));
      
      // Add active class to clicked button and corresponding pane
      const tabId = this.getAttribute('data-tab');
      this.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });
});
