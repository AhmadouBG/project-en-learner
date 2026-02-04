function renderMeaning(data) {
  // Show container
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
export { renderMeaning };
