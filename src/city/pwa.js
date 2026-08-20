/* Service-worker registration. Safe no-op on file:// and in the bundled build. */
function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  if(location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', ()=>{
    /* sw.js sits at the site root; its own path sets the scope, so a page in
       /city/ or /creator/ can register it and get the whole site cached. */
    navigator.serviceWorker.register('../sw.js')
      .catch(err => console.warn('SW registration skipped:', err));
  });
}
export { registerServiceWorker };
