interface RequestHandlers {
  before: (details: chrome.webRequest.OnBeforeRequestDetails) => undefined;
  completed: (details: chrome.webRequest.OnCompletedDetails) => void;
  error: (details: chrome.webRequest.OnErrorOccurredDetails) => void;
  headers: (details: chrome.webRequest.OnHeadersReceivedDetails) => undefined;
}

// Optional hosts can be absent at installation and change while the SW runs.
// Registering HTTP(S) webRequest listeners with no granted hosts emits a browser
// runtime ERROR. Do not request extra authority merely to register observers.
export function watchRequests(handlers: RequestHandlers, clearBindings: () => void): () => Promise<void> {
  let serial = Promise.resolve(), scope = '';
  return () => {
    const sync = async () => {
      const origins = [...new Set((await chrome.permissions.getAll()).origins?.filter(p => /^https?:\/\//.test(p)) ?? [])].sort();
      const next = JSON.stringify(origins);
      if (scope === next) return;
      chrome.webRequest.onBeforeRequest.removeListener(handlers.before);
      chrome.webRequest.onCompleted.removeListener(handlers.completed);
      chrome.webRequest.onErrorOccurred.removeListener(handlers.error);
      chrome.webRequest.onHeadersReceived.removeListener(handlers.headers);
      clearBindings();
      if (origins.length) {
        const filter = { urls: origins };
        chrome.webRequest.onBeforeRequest.addListener(handlers.before, filter);
        chrome.webRequest.onCompleted.addListener(handlers.completed, filter);
        chrome.webRequest.onErrorOccurred.addListener(handlers.error, filter);
        chrome.webRequest.onHeadersReceived.addListener(handlers.headers, filter, ['responseHeaders']);
      }
      scope = next;
    };
    const pending = serial.then(sync, sync);
    serial = pending;
    return pending;
  };
}
