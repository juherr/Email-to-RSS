// Interactive scripts for UI elements
// Handles modals, toggles, and other UI interactions

export const modalScripts = `
  // Modal Functionality
  function setupModals() {
    const modalTriggers = document.querySelectorAll('[data-modal-target]');
    
    modalTriggers.forEach(trigger => {
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        const modalId = trigger.getAttribute('data-modal-target');
        const modal = document.getElementById(modalId);
        
        if (modal) {
          modal.classList.add('visible');
        }
      });
    });
    
    // Close modals when clicking outside or on close button
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-bg') || e.target.classList.contains('modal-close')) {
        const modal = e.target.closest('.modal-bg');
        if (modal) {
          modal.classList.remove('visible');
        }
      }
    });
    
    // Close modals with ESC key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const visibleModals = document.querySelectorAll('.modal-bg.visible');
        visibleModals.forEach(modal => {
          modal.classList.remove('visible');
        });
      }
    });
  }
`;

export const emailViewScripts = `
  // Toggle email view functions
  function showRendered() {
    document.getElementById('rendered-view').style.display = 'block';
    document.getElementById('raw-view').style.display = 'none';
    document.getElementById('rendered-button').classList.add('active');
    document.getElementById('raw-button').classList.remove('active');
  }
  
  function showRaw() {
    document.getElementById('rendered-view').style.display = 'none';
    document.getElementById('raw-view').style.display = 'block';
    document.getElementById('rendered-button').classList.remove('active');
    document.getElementById('raw-button').classList.add('active');
  }
`;

export const initScripts = `
  // Initialize all interactive elements
  function initInteractive() {
    setupModals();
    setupCopyableElements(); // Initialize copyable elements
    
    // Make these functions globally available
    window.showRendered = showRendered;
    window.showRaw = showRaw;
  }
  
  // Run setup when DOM is fully loaded
  document.addEventListener('DOMContentLoaded', initInteractive);
`;
