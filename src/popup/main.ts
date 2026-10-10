const toggle = document.querySelector<HTMLInputElement>('#toggle')!
const status = document.querySelector<HTMLParagraphElement>('#status')!

function render(enabled: boolean) {
  toggle.checked = enabled
  status.textContent = enabled ? 'Status: ON' : 'Status: OFF'
}

void browser.storage.local.get('enabled').then((stored) => render(stored.enabled === true))

toggle.addEventListener('change', () => {
  void browser.storage.local.set({ enabled: toggle.checked }).then(() => render(toggle.checked))
})
