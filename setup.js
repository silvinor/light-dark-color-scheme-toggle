// Copy buttons for setup.html. Separate file because the extension page CSP
// blocks inline script.
for (const button of document.querySelectorAll('button[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    } catch {
      // Clipboard denied. The text is on screen and selectable anyway.
    }
  });
}
