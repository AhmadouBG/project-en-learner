// src/components/Panel/Panel.js - COMPLETE UPDATED VERSION

// Attempt to dynamically load modules
let showMeaning = (text) => {
  console.warn("MeaningView not loaded yet", text);
};
let phoneticView = null;
let mediaPlayer = null;

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

// Create toggle button immediately
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

// ✅ LOAD ALL MODULES AND INITIALIZE PROPERLY
(async () => {
  try {
    console.log('🚀 Loading extension modules...');

    // ✅ Step 1: Load all modules in parallel
    const [meaningMod, phoneticMod, mediaPlayerMod] = await Promise.all([
      import(chrome.runtime.getURL("src/components/MeaningView/MeaningView.js"))
        .catch(err => {
          console.error("Failed to load MeaningView:", err);
          return null;
        }),
      import(chrome.runtime.getURL("src/components/PhoneticView/PhoneticView.js"))
        .catch(err => {
          console.error("Failed to load PhoneticView:", err);
          return null;
        }),
      import(chrome.runtime.getURL("src/components/MediaPlayer/MediaPlayer.js"))
        .catch(err => {
          console.error("Failed to load MediaPlayer:", err);
          return null;
        })
    ]);

    // Assign modules
    if (meaningMod && typeof meaningMod.showMeaning === "function") {
      showMeaning = meaningMod.showMeaning;
      console.log("✅ MeaningView loaded");
    }

    if (phoneticMod && phoneticMod.phoneticView) {
      phoneticView = phoneticMod.phoneticView;
      console.log("✅ PhoneticView loaded");
    }

    if (mediaPlayerMod && mediaPlayerMod.mediaPlayer) {
      mediaPlayer = mediaPlayerMod.mediaPlayer;
      console.log("✅ MediaPlayer loaded");
    }

    // ✅ Step 2: Load Panel HTML
    const panelHtmlUrl = chrome.runtime.getURL("src/components/Panel/Panel.html");
    console.log("Fetching Panel.html from:", panelHtmlUrl);

    const response = await fetch(panelHtmlUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log("Panel.html fetched successfully");

    panelRoot.innerHTML = html;
    document.body.appendChild(panelRoot);
    console.log("✅ Panel HTML loaded and appended");

    // ✅ Step 3: Bind panel events
    bindPanelEvents();

    // ✅ Step 4: Wait for DOM to be fully rendered, then initialize modules
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        console.log('🔧 Initializing modules...');

        // Initialize PhoneticView
        if (phoneticView) {
          const phoneticSuccess = phoneticView.init();
          console.log('PhoneticView initialized:', phoneticSuccess);
        } else {
          console.warn('⚠️ phoneticView not loaded');
        }

        // Initialize MediaPlayer with panelRoot
        if (mediaPlayer) {
          const mediaSuccess = mediaPlayer.init(panelRoot);
          console.log('MediaPlayer initialized:', mediaSuccess);
          
          if (!mediaSuccess) {
            console.error('❌ MediaPlayer initialization failed');
            console.log('Debug: Checking panel elements...');
            console.log('Panel root:', panelRoot);
            console.log('Play button:', panelRoot.querySelector('#play-tts-btn'));
          }
        } else {
          console.warn('⚠️ mediaPlayer not loaded');
        }

        console.log('✅ Extension fully initialized!');
      });
    });

  } catch (err) {
    console.error("❌ Failed to initialize extension:", err);
  }
})();

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
    toggleBtn.classList.remove("active");
  });

  // Capture text selection
  document.addEventListener("mouseup", () => {
    const text = window.getSelection().toString().trim();
    if (text) {
      selectedText = text;
      contentInput.value = text;
      panelRoot.classList.add("active");
      toggleBtn.classList.add("active");
      
      // ✅ Clear selection after capturing
      setTimeout(() => {
        window.getSelection().removeAllRanges();
      }, 50);
      
      // Load phonetics
      if (phoneticView) {
        phoneticView.loadPhonetics(text);
      }

      // ✅ Set text for media player
      if (mediaPlayer) {
        mediaPlayer.setText(text);
      }
    }
  });

  // Input change
  contentInput.addEventListener("input", e => {
    selectedText = e.target.value;
    
    // Update phonetics
    if (phoneticView && selectedText.trim()) {
      phoneticView.loadPhonetics(selectedText);
    }

    // ✅ Update media player text
    if (mediaPlayer) {
      mediaPlayer.setText(selectedText);
    }
  });

  // Get meaning button
  getMeaningBtn.addEventListener("click", () => {
    if (!selectedText) {
      alert("Please select some text first");
      return;
    }
    showMeaning(selectedText);
  });

  // ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (panelRoot.classList.contains('active')) {
        panelRoot.classList.remove('active');
        toggleBtn.classList.remove('active');
      }
    }
  });

  // Click outside to close
  document.addEventListener('mousedown', (e) => {
    if (panelRoot.classList.contains('active') && 
        !panelRoot.contains(e.target) && 
        !toggleBtn.contains(e.target)) {
      panelRoot.classList.remove('active');
      toggleBtn.classList.remove('active');
    }
  });
}