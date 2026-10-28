const POLL_INTERVAL_MS = 3000;
const PHASE_LABELS = {
  enrollment: '📸 Enrollment — guests are adding photos',
  voting: '🗳️ Voting is open',
  closed: '🏆 Voting closed',
};

const $ = (id) => document.getElementById(id);

let password = sessionStorage.getItem('adminPassword') || '';
let pollTimer = null;

async function adminApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return body;
}

function resultTile(entry, rank, phase) {
  const tile = document.createElement('div');
  tile.className = 'entry';
  const image = document.createElement('img');
  image.src = entry.photoUrl;
  image.alt = entry.name;
  image.loading = 'lazy';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = `${phase === 'enrollment' ? '' : `#${rank} `}${entry.name}`;
  tile.append(image, name);

  if (phase !== 'enrollment') {
    const votes = document.createElement('div');
    votes.className = 'votes';
    votes.textContent = `${entry.votes} vote${entry.votes === 1 ? '' : 's'}`;
    tile.append(votes);
  }

  const remove = document.createElement('button');
  remove.className = 'remove secondary';
  remove.textContent = '🗑️ Remove';
  remove.addEventListener('click', async () => {
    if (confirm(`Remove "${entry.name}" from the contest?`)) {
      await adminApi('/api/admin/entries', { method: 'DELETE', body: JSON.stringify({ entryId: entry.id }) });
      await refresh();
    }
  });
  tile.append(remove);
  return tile;
}

function renderWinner(entries) {
  const topVotes = entries[0]?.votes || 0;
  const winners = entries.filter((entry) => topVotes > 0 && entry.votes === topVotes);
  if (winners.length === 0) {
    return [];
  }
  const heading = document.createElement('h2');
  heading.textContent = winners.length > 1 ? '🏆 It’s a tie!' : '🏆 And the winner is…';
  return [
    heading,
    ...winners.flatMap((winner) => {
      const image = document.createElement('img');
      image.src = winner.photoUrl;
      image.alt = winner.name;
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${winner.name} — ${winner.votes} votes`;
      return [image, name];
    }),
  ];
}

function render({ phase, totalVotes, entries }) {
  $('phase-pill').textContent = PHASE_LABELS[phase];
  $('start').classList.toggle('hidden', phase !== 'enrollment');
  $('close').classList.toggle('hidden', phase !== 'voting');
  $('reopen').classList.toggle('hidden', phase !== 'closed');
  $('back').classList.toggle('hidden', phase !== 'voting');
  $('totals').textContent = `${entries.length} costume${entries.length === 1 ? '' : 's'} · ${totalVotes} vote${
    totalVotes === 1 ? '' : 's'
  }`;

  const winner = phase === 'closed' ? renderWinner(entries) : [];
  $('winner').replaceChildren(...winner);
  $('winner').classList.toggle('hidden', winner.length === 0);

  $('results').replaceChildren(...entries.map((entry, index) => resultTile(entry, index + 1, phase)));
}

async function refresh() {
  try {
    render(await adminApi('/api/admin/results'));
  } catch (error) {
    if (error.status === 401) {
      logout(error.message);
    }
  }
}

async function setPhase(phase, confirmation) {
  if (confirmation && !confirm(confirmation)) {
    return;
  }
  await adminApi('/api/admin/phase', { method: 'POST', body: JSON.stringify({ phase }) });
  await refresh();
}

function logout(message) {
  clearInterval(pollTimer);
  sessionStorage.removeItem('adminPassword');
  $('panel').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('login-message').textContent = message;
  $('login-message').classList.remove('hidden');
}

async function login() {
  password = $('password').value;
  try {
    render(await adminApi('/api/admin/results'));
    sessionStorage.setItem('adminPassword', password);
    $('login').classList.add('hidden');
    $('panel').classList.remove('hidden');
    pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  } catch (error) {
    $('login-message').textContent = error.message;
    $('login-message').classList.remove('hidden');
  }
}

$('login-button').addEventListener('click', login);
$('password').addEventListener('keydown', (event) => event.key === 'Enter' && login());
$('start').addEventListener('click', () => setPhase('voting', 'Start voting? Guests will see all costumes.'));
$('close').addEventListener('click', () => setPhase('closed', 'Close voting and reveal the winner?'));
$('reopen').addEventListener('click', () => setPhase('voting'));
$('back').addEventListener('click', () => setPhase('enrollment', 'Hide the voting from guests again?'));

if (password) {
  $('password').value = password;
  login();
}
