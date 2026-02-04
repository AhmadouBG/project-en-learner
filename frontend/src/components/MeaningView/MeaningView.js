const API_URL = "http://localhost:8000/meaning";

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
  const container = document.getElementById("meaning-view");

  container.innerHTML = `
    <div class="meaning-box">
      <button id="close-meaning">✕</button>

      <p class="meaning-text">${data.meaning}</p>

      <div class="synonym-tags">
        ${data.synonyms.map(s => `<span>${s}</span>`).join("")}
      </div>

      <ul class="example-list">
        ${data.examples.map(e => `<li>${e}</li>`).join("")}
      </ul>
    </div>
  `;

  container.classList.add("show");

  document
    .getElementById("close-meaning")
    .addEventListener("click", () => {
      container.classList.remove("show");
      container.innerHTML = "";
    });
}
