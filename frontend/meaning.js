const API_URL = "http://localhost:8000/meaning";

async function fetchMeaning(text) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error("Failed to fetch meaning");
  }

  return response.json();
}
export { fetchMeaning };