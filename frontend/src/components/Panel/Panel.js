// src/components/Panel/Panel.js - UPDATE

// Attempt to dynamically load MeaningView
let showMeaning = (text) => {
  console.warn("MeaningView not loaded yet", text);
};

// NEW: Load PhoneticView
let phoneticView = null;

(async () => {
  try {
    // Load MeaningView (existing)
    const meaningMod = await import(chrome.runtime.getURL("src/components/MeaningView/MeaningView.js"));
    if (meaningMod && typeof meaningMod.showMeaning === "function") {
      showMeaning = meaningMod.showMeaning;
      console.log("✅ MeaningView loaded");
    }

    // NEW: Load PhoneticView
    const phoneticMod = await import(chrome.runtime.getURL("src/components/PhoneticView/PhoneticView.js"));
    if (phoneticMod && phoneticMod.phoneticView) {
      phoneticView = phoneticMod.phoneticView;
      console.log("✅ PhoneticView loaded");
    }
  } catch (err) {
    console.error("Failed to load modules:", err);
  }
})();

// Load Panel CSS (existing)
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = chrome.runtime.getURL("src/components/Panel/Panel.css");
link.onload = () => console.log("Panel.css loaded");
link.onerror = (e) => console.error("Failed to load Panel.css:", e);
document.head.appendChild(link);

let selectedText = "";

const panelRoot = document.createElement("div");
panelRoot.id = "ai-teaching-panel-root";

// Toggle button (existing)
const toggleBtn = document.createElement("button");
toggleBtn.id = "ai-panel-toggle";
toggleBtn.innerHTML = `
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="white"/>
    <path d="M2 17L12 22L22 17M2 12L12 17L22 12"
      stroke="white" stroke-width="2"/>
  </svg>
`;
document.body.appendChild(toggleBtn);

toggleBtn.addEventListener("click", () => {
  panelRoot.classList.toggle("active");
  toggleBtn.classList.toggle("active");
});

// Load Panel.html
const panelHtmlUrl = chrome.runtime.getURL("src/components/Panel/Panel.html");

fetch(panelHtmlUrl)
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
  })
  .then(html => {
    panelRoot.innerHTML = html;
    document.body.appendChild(panelRoot);
    console.log("✅ Panel loaded");

    bindPanelEvents();
    
    // NEW: Initialize PhoneticView after panel is loaded
    if (phoneticView) {
      phoneticView.init();
      console.log('✅ PhoneticView initialized');

    }
  })
  .catch(err => {
    console.error("❌ Failed to load Panel.html:", err);
  });

function bindPanelEvents() {
  const contentInput = document.getElementById("content-input");
  const getMeaningBtn = document.getElementById("get-meaning-btn");
  const closePanelBtn = document.getElementById("close-panel-btn");

  if (!contentInput || !getMeaningBtn || !closePanelBtn) {
    console.error("❌ Panel elements not found");
    return;
  }

  // Close panel
  closePanelBtn.addEventListener("click", () => {
    panelRoot.classList.remove("active");
  });

  // Capture text selection
  document.addEventListener("mouseup", () => {
    const text = window.getSelection().toString().trim();
    if (text) {
      selectedText = text;
      contentInput.value = text;
      panelRoot.classList.add("active");
      
      // NEW: Load phonetics when text selected
      if (phoneticView) {
        phoneticView.loadPhonetics(text);
      }
    }
  });

  // Input change
  contentInput.addEventListener("input", e => {
    selectedText = e.target.value;
    
    // NEW: Update phonetics when typing
    if (phoneticView && selectedText.trim()) {
      phoneticView.loadPhonetics(selectedText);
    }
  });

  // Get meaning button
  getMeaningBtn.addEventListener("click", () => {
    if (!selectedText) {
      alert("Please select some text first");
      return;
    }
    
    // Show meaning (existing)
    showMeaning(selectedText);
    
    // NEW: Also load phonetics
    if (phoneticView) {
      phoneticView.loadPhonetics(selectedText);
    }
  });

  // ESC key (existing)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelRoot.classList.contains('active')) {
      panelRoot.classList.remove('active');
      toggleBtn.classList.remove('active');
    }
  });

  // Click outside (existing)
  document.addEventListener('mousedown', (e) => {
    if (panelRoot.classList.contains('active') && 
        !panelRoot.contains(e.target) && 
        !toggleBtn.contains(e.target)) {
      panelRoot.classList.remove('active');
      toggleBtn.classList.remove('active');
    }
  });
}