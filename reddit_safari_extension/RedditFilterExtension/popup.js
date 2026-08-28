document.addEventListener('DOMContentLoaded', () => {
  const minLikesInput = document.getElementById('minLikes');
  const iconModeInput = document.getElementById('iconMode');
  const hideAfterSaveInput = document.getElementById('hideAfterSave');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  // Load saved settings
  browser.storage.sync.get({ minLikes: 0, iconMode: true, hideAfterSave: false }, (items) => {
    minLikesInput.value = items.minLikes;
    iconModeInput.checked = items.iconMode;
    hideAfterSaveInput.checked = items.hideAfterSave;
  });

  saveBtn.addEventListener('click', () => {
    browser.storage.sync.set({
      minLikes: parseInt(minLikesInput.value, 10),
      iconMode: iconModeInput.checked,
      hideAfterSave: hideAfterSaveInput.checked,
    }, () => {
      status.textContent = 'Options saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});
