document.querySelector('button').addEventListener('click', async () => {
  document.body.dataset.permission = await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] }) ? 'granted' : 'denied';
});
