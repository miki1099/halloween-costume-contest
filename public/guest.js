const MAX_PHOTO_SIDE = 1280;
const POLL_INTERVAL_MS = 4000;

const $ = (id) => document.getElementById(id);

let photoDataUrl = null;
let state = { phase: 'enrollment', entries: [], myVote: null };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || 'Request failed');
  }
  return body;
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle('error', isError);
  element.classList.remove('hidden');
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => reject(new Error('Could not read that photo'));
    image.src = url;
  });
}

async function resizeToJpeg(file) {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function onPhotoPicked(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) {
    return;
  }
  try {
    photoDataUrl = await resizeToJpeg(file);
    $('preview').src = photoDataUrl;
    $('preview').classList.remove('hidden');
    $('enroll-message').classList.add('hidden');
    updateSubmitState();
  } catch (error) {
    showMessage($('enroll-message'), error.message, true);
  }
}

function updateSubmitState() {
  $('submit').disabled = !photoDataUrl || !$('name').value.trim();
}

async function submitEntry() {
  $('submit').disabled = true;
  $('submit').textContent = '🧙 Brewing…';
  try {
    await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({ name: $('name').value, photo: photoDataUrl }),
    });
    photoDataUrl = null;
    $('name').value = '';
    $('preview').classList.add('hidden');
    await refresh();
  } catch (error) {
    showMessage($('enroll-message'), error.message, true);
  } finally {
    $('submit').textContent = '🕸️ Enter the contest';
    updateSubmitState();
  }
}

async function vote(entryId) {
  try {
    const { myVote } = await api('/api/vote', { method: 'POST', body: JSON.stringify({ entryId }) });
    state.myVote = myVote;
    $('vote-message').classList.add('hidden');
    render();
  } catch (error) {
    showMessage($('vote-message'), error.message, true);
  }
}

async function removeMyEntry() {
  if (!confirm('Remove your photo from the contest?')) {
    return;
  }
  try {
    await api('/api/entries/mine', { method: 'DELETE' });
    $('enroll-message').classList.add('hidden');
  } catch (error) {
    alert(error.message);
  }
  await refresh();
}

function entryTile(entry, { selectable, removable = false }) {
  const tile = document.createElement('div');
  tile.className = 'entry';
  const image = document.createElement('img');
  image.src = entry.photoUrl;
  image.alt = entry.name;
  image.loading = 'lazy';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.name;
  tile.append(image, name);

  if (entry.mine) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'You';
    tile.append(badge);
    if (removable) {
      const remove = document.createElement('button');
      remove.className = 'remove secondary';
      remove.textContent = '🗑️ Remove my photo';
      remove.addEventListener('click', removeMyEntry);
      tile.append(remove);
    }
  } else if (selectable) {
    tile.classList.add('selectable');
    tile.addEventListener('click', () => vote(entry.id));
    if (state.myVote === entry.id) {
      tile.classList.add('voted');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '✓ Your vote';
      tile.append(badge);
    }
  }
  return tile;
}

function render() {
  const { phase, entries } = state;
  const mine = entries.filter((entry) => entry.mine);

  $('enroll').classList.toggle('hidden', phase === 'closed' || mine.length > 0);
  $('entries-section').classList.toggle('hidden', phase === 'closed' || entries.length === 0);
  $('closed-section').classList.toggle('hidden', phase !== 'closed');

  if (phase === 'voting') {
    $('entries-pill').textContent = '🗳️ Voting is open — tap your favourite costume';
  } else if (mine.length > 0) {
    $('entries-pill').textContent = "🎉 You're in! Wait for the host to open voting.";
  } else {
    $('entries-pill').textContent = '👻 Costumes so far';
  }

  $('subtitle').textContent =
    phase === 'voting'
      ? 'Voting is open! You can change your vote until the host closes it.'
      : 'Snap your costume and join the contest!';

  const ordered = [...mine, ...entries.filter((entry) => !entry.mine)];
  $('entries').replaceChildren(
    ...ordered.map((entry) =>
      entryTile(entry, { selectable: phase === 'voting', removable: phase === 'enrollment' }),
    ),
  );
}

async function refresh() {
  try {
    const next = await api('/api/state');
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (changed) {
      render();
    }
  } catch {
    // Keep showing the last known state while the party wifi hiccups.
  }
}

$('camera').addEventListener('change', onPhotoPicked);
$('gallery').addEventListener('change', onPhotoPicked);
$('name').addEventListener('input', updateSubmitState);
$('submit').addEventListener('click', submitEntry);

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
