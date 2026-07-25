// Reusable drag-and-drop file picker tile. Wires a clickable/droppable tile
// to an existing (visually hidden) <input type="file">, so either a click or
// a drag-and-drop ends up populating the same file input the rest of the
// page's upload logic already reads from. Doesn't touch upload/submit logic.
function initDropzone({ dropzoneId, inputId, filenamesId }) {
  const dropzone = document.getElementById(dropzoneId);
  const input = document.getElementById(inputId);
  const filenamesEl = filenamesId ? document.getElementById(filenamesId) : null;

  function updateFilenames() {
    if (!filenamesEl) return;
    const files = input.files;
    if (!files || files.length === 0) {
      filenamesEl.textContent = "";
    } else if (files.length === 1) {
      filenamesEl.textContent = files[0].name;
    } else {
      filenamesEl.textContent = `${files.length} files selected`;
    }
  }

  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", updateFilenames);

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dropzone-active");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dropzone-active");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const dropped = e.dataTransfer && e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    if (!input.multiple && dropped.length > 1) {
      // Single-file input: only take the first dropped file.
      const dt = new DataTransfer();
      dt.items.add(dropped[0]);
      input.files = dt.files;
    } else {
      input.files = dropped;
    }
    updateFilenames();
  });

  return { updateFilenames };
}
