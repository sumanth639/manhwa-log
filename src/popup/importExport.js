// Wires popup import and export controls.
export function initImportExport(loadData) {
  document.getElementById("exportBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "EXPORT_LIST" }, ({ list }) => {
      const blob = new Blob([JSON.stringify(list, null, 2)], {
        type: "application/json",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "manhwa-log.json";
      link.click();
    });
  });

  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });

  document.getElementById("importFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const statusEl = document.getElementById("importStatus");
    const reader = new FileReader();

    reader.onload = (loadEvent) => {
      try {
        const list = JSON.parse(loadEvent.target.result);
        if (!Array.isArray(list)) throw new Error("Invalid format");

        chrome.runtime.sendMessage({ type: "IMPORT_LIST", list }, (res) => {
          if (res.success) {
            loadData();
            if (statusEl) {
              statusEl.innerHTML = "&#10003; Import successful - list merged.";
              statusEl.classList.remove("is-error");
              statusEl.classList.add("is-success");
              setTimeout(() => {
                statusEl.textContent = "";
                statusEl.classList.remove("is-success");
              }, 3000);
            }
          }
        });
      } catch (err) {
        if (statusEl) {
          statusEl.innerHTML = `&#10007; Import failed: ${err.message}`;
          statusEl.classList.remove("is-success");
          statusEl.classList.add("is-error");
          setTimeout(() => {
            statusEl.textContent = "";
            statusEl.classList.remove("is-error");
          }, 4000);
        }
      }
    };

    reader.readAsText(file);
    event.target.value = "";
  });
}
