const API_URL = "http://localhost:8000/api/meaning";

export async function showMeaning(text) {
  try {
    const data = await fetchMeaning(text);
    renderMeaning(data);
  } catch (err) {
    console.error(err);
    alert("Error fetching meaning");
  }
}

async function fetchMeaning(text) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error("API error");
  }

  return response.json();
}

function renderMeaning(data) {
  const meaningView = document.getElementById('meaning-view');
  const closeMeaningBtn = document.getElementById('close-meaning');
  
  meaningView.style.display = 'block';
  closeMeaningBtn.style.display = 'inline-block';

  // allow display to apply before animation
  requestAnimationFrame(() => {
    meaningView.classList.add('show');
    closeMeaningBtn.classList.add('show');
  });

  // Meaning
  document.getElementById("ui-meaning-text").textContent = data.meaning;

  // Synonyms
  const synonymContainer = document.querySelector(".synonym-tags");
  synonymContainer.innerHTML = "";
  data.synonyms.forEach(word => {
    const span = document.createElement("span");
    span.className = "synonym-tag";
    span.textContent = word;
    synonymContainer.appendChild(span);
  });

  // Examples
  const exampleList = document.querySelector(".example-list");
  exampleList.innerHTML = "";
  data.examples.forEach(ex => {
    const li = document.createElement("li");
    li.textContent = ex;
    exampleList.appendChild(li);
  });
}

