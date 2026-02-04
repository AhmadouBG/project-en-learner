// Panel.js - Standalone script (no ES6 imports in content scripts)

// Load external CSS file for the panel
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = chrome.runtime.getURL("src/components/Panel/Panel.css");
link.onload = () => console.log("Panel.css loaded");
link.onerror = (e) => console.error("Failed to load Panel.css:", e);
document.head.appendChild(link);

let selectedText = "";

const panelRoot = document.createElement("div");
panelRoot.id = "ai-teaching-panel-root";

// Create toggle button immediately (first element visible)
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
console.log("Toggle button created");

toggleBtn.addEventListener("click", () => {
  panelRoot.classList.toggle("active");
  toggleBtn.classList.toggle("active");
});

// Load Panel.html asynchronously
const panelHtmlUrl = chrome.runtime.getURL("src/components/Panel/Panel.html");
console.log("Attempting to fetch Panel.html from:", panelHtmlUrl);

fetch(panelHtmlUrl)
  .then(res => {
    console.log("Panel.html response status:", res.status);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
  })
  .then(html => {
    console.log("Panel.html fetched successfully, length:", html.length);
    panelRoot.innerHTML = html;
    document.body.appendChild(panelRoot);
    console.log("Panel loaded and appended");

    bindPanelEvents();
  })
  .catch(err => {
    console.error("Failed to load Panel.html:", err);
    console.error("Tried URL:", panelHtmlUrl);
  });

function bindPanelEvents() {
  const contentInput = document.getElementById("content-input");
  const getMeaningBtn = document.getElementById("get-meaning-btn");
  const closePanelBtn = document.getElementById("close-panel-btn");

  if (!contentInput || !getMeaningBtn || !closePanelBtn) {
    console.error("Panel elements not found");
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
    }
  });

  // Manual input
  contentInput.addEventListener("input", e => {
    selectedText = e.target.value;
  });

  // Meaning intent
  getMeaningBtn.addEventListener("click", () => {
    if (!selectedText) {
      alert("Please select or enter text first");
      return;
    }
    console.log("Requesting meaning for:", selectedText);
  });

   // Fix the ESC key listener
   document.addEventListener('keydown', (e) => {
     if (e.key === 'Escape') {
        
        // Close main panel
        if (panelRoot.classList.contains('active')) {
        panelRoot.classList.remove('active');
        toggleBtn.classList.remove('active');
        }
    }
    });

  
  // Close panel when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (panelRoot.classList.contains('active') && !panelRoot.contains(e.target) && 
        !toggleBtn.contains(e.target)) {

        panelRoot.classList.remove('active');
        toggleBtn.classList.remove('active');
      }
   });
}
