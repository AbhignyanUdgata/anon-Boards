/**
 * ═══════════════════════════════════════════════════════
 *  ANON·BOARDS — auth.js
 *  Authentication · User Management · Admin Panel
 *
 *  Depends on globals defined in index.html's inline script:
 *    sbClient, sqlDB, SESSION_NAME, posts, forums, BOARDS,
 *    genAnonName, getRandomEmoji, showToast, openModal,
 *    closeModal, renderPosts, updateReportsList,
 *    saveForumsToDatabase, syncToSQLite, saveAutosaveLink
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ── STATE ─────────────────────────────────────────────────────────────────
let authenticatedUser = null;   // Currently logged-in user object
let allUsers          = [];     // In-memory mirror of Supabase users table
let dbInitialized     = false;  // Set true once Supabase load is complete
let moderatorRequests = [];     // Pending mod-status requests (in-memory)

const DEFAULT_ADMIN = 'Abhignyan1103';

// ── PASSWORD HASHING ──────────────────────────────────────────────────────
// NOTE: djb2-style hash used for demo. Replace with bcrypt/argon2 server-side
// for a real production deployment.
function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    hash = ((hash << 5) - hash) + password.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// ── SUPABASE USER PERSISTENCE ─────────────────────────────────────────────

/**
 * Upsert the full allUsers array into Supabase.
 * Also triggers a sql.js sync so the downloadable .sql file stays current.
 */
async function saveUsersToDatabase(users) {
  const rows = users.map(u => ({
    id:             u.id,
    username:       u.username,
    password_hash:  u.passwordHash  || '',
    emoji:          u.emoji         || '',
    anon_id:        u.anonID        || '',
    created_at:     u.createdAt     || 0,
    last_login:     u.lastLogin     || 0,
    is_admin:       u.isAdmin       ? true : false,
    is_super_admin: u.isSuperAdmin  ? true : false,
    favorites:      u.favorites     || []
  }));

  const { error } = await sbClient.from('users').upsert(rows, { onConflict: 'id' });
  if (error) console.error('saveUsersToDatabase error:', error.message);

  // Keep the downloadable SQL backup up to date
  if (typeof sqlDB !== 'undefined' && sqlDB) {
    syncToSQLite().then(() => saveAutosaveLink()).catch(() => {});
  }
  return !error;
}

/**
 * Load the full users list from Supabase and map columns → JS object shape.
 */
async function loadUsersFromDatabase() {
  const { data, error } = await sbClient.from('users').select('*');
  if (error || !data) return [];
  return data.map(r => ({
    id:           r.id,
    username:     r.username,
    passwordHash: r.password_hash,
    emoji:        r.emoji,
    anonID:       r.anon_id,
    createdAt:    r.created_at,
    lastLogin:    r.last_login,
    isAdmin:      r.is_admin,
    isSuperAdmin: r.is_super_admin,
    favorites:    Array.isArray(r.favorites) ? r.favorites : []
  }));
}

// ── REALTIME — USERS TABLE ────────────────────────────────────────────────
/**
 * Subscribe to Supabase Realtime changes on the users table.
 * Called from the main initializeSyncChannel() after Supabase is ready.
 * This is what makes registrations on other tabs instantly visible here.
 */
function initUsersSyncChannel() {
  sbClient.channel('realtime:users')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, payload => {
      const { eventType, new: row, old } = payload;

      if (eventType === 'DELETE') {
        allUsers = allUsers.filter(u => u.id !== old.id);

      } else if (row) {
        const incoming = {
          id:           row.id,
          username:     row.username,
          passwordHash: row.password_hash,
          emoji:        row.emoji,
          anonID:       row.anon_id,
          createdAt:    row.created_at,
          lastLogin:    row.last_login,
          isAdmin:      row.is_admin,
          isSuperAdmin: row.is_super_admin,
          favorites:    Array.isArray(row.favorites) ? row.favorites : []
        };

        const idx = allUsers.findIndex(u => u.id === incoming.id);
        if (idx >= 0) {
          // Don't overwrite our own authenticated session object
          if (!authenticatedUser || authenticatedUser.id !== incoming.id) {
            allUsers[idx] = incoming;
          }
        } else {
          allUsers.push(incoming);
          console.log('✓ New user synced in real-time:', incoming.username);
        }
      }

      // Keep SQL backup current
      if (typeof sqlDB !== 'undefined' && sqlDB) {
        syncToSQLite().then(() => saveAutosaveLink()).catch(() => {});
      }
    })
    .subscribe(status => console.log('Users realtime channel:', status));
}

// ── ACCOUNT CREATION ──────────────────────────────────────────────────────
async function createUserAccount(username, password) {
  if (!username || username.trim().length < 3) {
    showToast('❌ Username must be at least 3 characters');
    return false;
  }
  if (!password || password.length < 6) {
    showToast('❌ Password must be at least 6 characters');
    return false;
  }

  // Always check freshly against Supabase in case another tab just registered
  const freshUsers = await loadUsersFromDatabase();
  if (freshUsers.length > 0) allUsers = freshUsers;

  if (allUsers.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    showToast('❌ Username already taken');
    return false;
  }

  const newUser = {
    id:           'user_' + Date.now(),
    username:     username.trim(),
    passwordHash: hashPassword(password),
    emoji:        getRandomEmoji(),
    anonID:       genAnonName(),   // Fixed identity tied to this account forever
    createdAt:    Date.now(),
    favorites:    [],
    lastLogin:    Date.now(),
    isAnonymous:  false,
    isAdmin:      false,
    isSuperAdmin: false
  };

  allUsers.push(newUser);
  await saveUsersToDatabase(allUsers);

  console.log('✓ Account created:', newUser.username);
  return true;
}

// ── LOGIN ─────────────────────────────────────────────────────────────────
async function loginUser(username, password) {
  // Always fetch the latest list from Supabase — users registered in other
  // tabs won't be in the stale in-memory allUsers without this.
  const freshUsers = await loadUsersFromDatabase();
  if (freshUsers.length > 0) allUsers = freshUsers;

  const user = allUsers.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user) {
    showToast('❌ Username not found');
    return false;
  }
  if (user.passwordHash !== hashPassword(password)) {
    showToast('❌ Incorrect password');
    return false;
  }

  // Back-fill anonID for accounts created before this field was added
  if (!user.anonID) {
    user.anonID = genAnonName();
    console.log('✓ Generated missing anonID for legacy account:', user.anonID);
  }

  user.lastLogin    = Date.now();
  authenticatedUser = user;

  _applySessionIdentity(user.anonID);
  await saveUsersToDatabase(allUsers);
  localStorage.setItem('lastLoggedInUsername', user.username);

  updateLoginUI();
  closeModal('login-modal');
  showToast('✓ Welcome back, ' + user.username);
  console.log('✓ Logged in as:', user.username);
  return true;
}

// Auto-login after registration (does not close any modal)
async function autoLoginUser(username, password) {
  const user = allUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    console.error('autoLoginUser: user not found or password mismatch');
    return false;
  }

  if (!user.anonID) user.anonID = genAnonName();

  user.lastLogin    = Date.now();
  authenticatedUser = user;

  _applySessionIdentity(user.anonID);
  localStorage.setItem('lastLoggedInUsername', user.username);

  updateLoginUI();
  showToast('✓ Logged in as ' + user.username);
  console.log('✓ Auto-logged in as:', user.username);
  return true;
}

// ── LOGOUT ────────────────────────────────────────────────────────────────
function logoutUser() {
  authenticatedUser = null;
  _applySessionIdentity(genAnonName());   // Fresh anonymous identity
  localStorage.removeItem('lastLoggedInUsername');
  updateLoginUI();
  showToast('✓ Logged out — new anonymous session started');
  renderPosts();
}

// ── HELPERS ───────────────────────────────────────────────────────────────

/** Write a new anonID into SESSION_NAME and every DOM element that shows it. */
function _applySessionIdentity(anonID) {
  SESSION_NAME = anonID;
  const ids = ['session-id', 'reply-anon-name', 'new-anon-name'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = SESSION_NAME;
  });
}

function getUserByUsername(username) {
  return allUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
}

function isUserAdmin(username) {
  const u = getUserByUsername(username);
  return u ? u.isAdmin : false;
}

// ── PROFILE CHANGES ───────────────────────────────────────────────────────

function openChangeUsernameModal() {
  if (!authenticatedUser) { showToast('❌ Must be logged in'); return; }
  openModal('change-username-modal');
}

function submitChangeUsername() {
  if (!authenticatedUser) { showToast('❌ Not logged in'); return; }

  const newUsername = document.getElementById('change-username-input').value.trim();
  if (!newUsername || newUsername.length < 3) {
    showToast('❌ Username must be at least 3 characters'); return;
  }
  if (newUsername.toLowerCase() === authenticatedUser.username.toLowerCase()) {
    showToast('❌ That is already your username'); return;
  }
  if (allUsers.some(u => u.username.toLowerCase() === newUsername.toLowerCase())) {
    showToast('❌ Username already taken'); return;
  }

  const oldUsername = authenticatedUser.username;
  authenticatedUser.username = newUsername;

  const idx = allUsers.findIndex(u => u.id === authenticatedUser.id);
  if (idx >= 0) allUsers[idx].username = newUsername;

  saveUsersToDatabase(allUsers);
  updateLoginUI();

  document.getElementById('change-username-input').value = '';
  closeModal('change-username-modal');
  showToast(`✓ Username changed from "${oldUsername}" to "${newUsername}"`);
}

async function changePassword(oldPassword, newPassword, confirmPassword) {
  if (!authenticatedUser) { showToast('❌ Not logged in'); return false; }
  if (hashPassword(oldPassword) !== authenticatedUser.passwordHash) {
    showToast('❌ Old password is incorrect'); return false;
  }
  if (newPassword !== confirmPassword) {
    showToast('❌ Passwords do not match'); return false;
  }
  if (newPassword.length < 6) {
    showToast('❌ Password must be at least 6 characters'); return false;
  }

  authenticatedUser.passwordHash = hashPassword(newPassword);
  await saveUsersToDatabase(allUsers);
  showToast('✓ Password changed successfully');
  return true;
}

// ── FAVOURITES ────────────────────────────────────────────────────────────

async function addToFavorites(postId) {
  if (!authenticatedUser) { showToast('⚠️ Login to save favourites'); return false; }
  if (!authenticatedUser.favorites.includes(postId)) {
    authenticatedUser.favorites.push(postId);
    await saveUsersToDatabase(allUsers);
  }
  return true;
}

async function removeFromFavorites(postId) {
  if (!authenticatedUser) return false;
  authenticatedUser.favorites = authenticatedUser.favorites.filter(id => id !== postId);
  await saveUsersToDatabase(allUsers);
  return true;
}

function getUserFavorites() {
  if (!authenticatedUser) return [];
  return posts.filter(p => authenticatedUser.favorites.includes(p.id));
}

// ── ADMIN PRIVILEGES ──────────────────────────────────────────────────────

async function grantAdminPrivileges(username) {
  const user = getUserByUsername(username);
  if (!user) { console.error(`User "${username}" not found`); return false; }
  user.isAdmin = true;
  await saveUsersToDatabase(allUsers);
  showToast(`✅ ${user.username} is now an ADMIN`);
  return true;
}

async function revokeAdminPrivileges(username) {
  const user = getUserByUsername(username);
  if (!user) { console.error(`User "${username}" not found`); return false; }
  user.isAdmin = false;
  await saveUsersToDatabase(allUsers);
  showToast(`✅ Admin privileges removed from ${user.username}`);
  return true;
}

// ── MODERATOR REQUEST SYSTEM ──────────────────────────────────────────────

function requestModeratorStatus(username, boardId, reason) {
  if (!username) { showToast('❌ Login required'); return false; }
  moderatorRequests.push({
    id:         Date.now(),
    username,
    boardId,
    reason,
    createdAt:  Date.now(),
    status:     'pending',
    reviewedBy: null,
    reviewedAt: null
  });
  return true;
}

function approveModerator(requestId, adminUsername) {
  const req = moderatorRequests.find(r => r.id === requestId);
  if (!req || !getUserByUsername(req.username)) return false;

  const forum = forums.find(f => f.id === req.boardId);
  if (forum && !forum.moderators.includes(req.username)) {
    forum.moderators.push(req.username);
    saveForumsToDatabase();
  }
  req.status     = 'approved';
  req.reviewedBy = adminUsername;
  req.reviewedAt = Date.now();
  return true;
}

function rejectModerator(requestId, adminUsername, reason) {
  const req = moderatorRequests.find(r => r.id === requestId);
  if (!req) return false;
  req.status          = 'rejected';
  req.reviewedBy      = adminUsername;
  req.reviewedAt      = Date.now();
  req.rejectionReason = reason;
  return true;
}

// ── LOGIN UI ──────────────────────────────────────────────────────────────

function updateLoginUI() {
  const loginBtn    = document.getElementById('login-menu-btn');
  const userDropdown = document.getElementById('user-menu-dropdown');
  if (!loginBtn) return;

  if (authenticatedUser) {
    // Assign emoji once if missing
    if (!authenticatedUser.emoji) {
      authenticatedUser.emoji = getRandomEmoji();
      saveUsersToDatabase(allUsers);
    }

    loginBtn.innerHTML = `
      <div class="user-avatar">${authenticatedUser.emoji}</div>
      <div class="user-username">
        <div class="username-text">${authenticatedUser.username}</div>
        <div class="username-status">ONLINE</div>
      </div>`;

    if (userDropdown) {
      const isAdmin = authenticatedUser.isAdmin;
      const adminItem = isAdmin
        ? `<div class="dropdown-item" style="color:var(--accent3);" onclick="toggleAdminPanel()">👑 Admin Panel</div>`
        : '';
      userDropdown.innerHTML = `
        <div class="dropdown-item" onclick="openUserProfile()">👤 My Profile</div>
        <div class="dropdown-item" onclick="openChangePasswordModal()">🔐 Change Password</div>
        <div class="dropdown-item" onclick="openChangeUsernameModal()" style="color:var(--accent3);">🏷️ Change Account Name</div>
        <div class="dropdown-item" onclick="openFavoritesView()">♥️ Saved Posts</div>
        ${adminItem}
        <div class="dropdown-item" style="color:var(--danger);" onclick="logoutUser()">🚪 Logout</div>`;
    }
  } else {
    loginBtn.innerHTML = `
      <div class="user-avatar">🔓</div>
      <div class="user-username">
        <div class="username-text">Login</div>
        <div class="username-status">GUEST</div>
      </div>`;

    if (userDropdown) {
      userDropdown.innerHTML = `
        <div class="dropdown-item" onclick="openModal('login-modal')">🔑 Login</div>
        <div class="dropdown-item" onclick="openModal('register-modal')">✍️ Create Account</div>`;
    }
  }
}

// ── FORM SUBMIT HANDLERS ──────────────────────────────────────────────────

async function submitLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { showToast('❌ Please enter username and password'); return; }

  const ok = await loginUser(username, password);
  if (ok) {
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
  }
}

async function registerNewAccount() {
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const confirm  = document.getElementById('register-confirm').value;

  if (password !== confirm) { showToast('❌ Passwords do not match'); return; }

  if (await createUserAccount(username, password)) {
    document.getElementById('register-username').value = '';
    document.getElementById('register-password').value = '';
    document.getElementById('register-confirm').value  = '';
    closeModal('register-modal');
    await autoLoginUser(username, password);
  }
}

async function submitChangePassword() {
  const oldPass = document.getElementById('old-password').value;
  const newPass = document.getElementById('new-password').value;
  const confirm = document.getElementById('confirm-new-password').value;
  if (!oldPass || !newPass || !confirm) { showToast('❌ Please fill all fields'); return; }

  if (await changePassword(oldPass, newPass, confirm)) {
    document.getElementById('old-password').value         = '';
    document.getElementById('new-password').value         = '';
    document.getElementById('confirm-new-password').value = '';
    closeModal('change-password-modal');
  }
}

// ── PROFILE PANEL ─────────────────────────────────────────────────────────

function openUserProfile() {
  if (!authenticatedUser) { showToast('❌ Not logged in'); return; }

  const panel = document.getElementById('profile-panel');
  if (!panel) return;
  panel.style.display = 'block';

  const avatarEl = document.getElementById('profile-avatar-emoji');
  if (avatarEl) avatarEl.textContent = authenticatedUser.emoji || '👤';

  const anonChip = document.getElementById('profile-anonid-display');
  if (anonChip) anonChip.textContent = authenticatedUser.anonID || SESSION_NAME;

  document.getElementById('profile-username').textContent = authenticatedUser.username;
  document.getElementById('profile-created').textContent  =
    'Member since ' + new Date(authenticatedUser.createdAt)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  document.getElementById('profile-favorites').textContent = authenticatedUser.favorites.length;

  // Post / reply counts for this user's anonID
  const aid = authenticatedUser.anonID || SESSION_NAME;
  const userPosts   = posts.filter(p => p.author === aid).length;
  const userReplies = posts.reduce((s, p) => s + p.replies.filter(r => r.author === aid).length, 0);
  const ppPosts   = document.getElementById('pp-posts-count');
  const ppReplies = document.getElementById('pp-replies-count');
  if (ppPosts)   ppPosts.textContent   = userPosts;
  if (ppReplies) ppReplies.textContent = userReplies;

  const adminBadge   = document.getElementById('profile-admin-badge');
  const adminSection = document.getElementById('admin-section');
  if (adminBadge)   adminBadge.style.display   = authenticatedUser.isAdmin ? 'block' : 'none';
  if (adminSection) {
    adminSection.style.display = authenticatedUser.isAdmin ? 'block' : 'none';
    if (authenticatedUser.isAdmin) updateAdminProfileList();
  }
}

function closeProfilePanel() {
  const panel = document.getElementById('profile-panel');
  if (panel) panel.style.display = 'none';
}

function openFavoritesView() {
  if (!authenticatedUser) { showToast('❌ Not logged in'); return; }
  const favs = getUserFavorites();
  if (favs.length === 0) { showToast('❌ No saved posts yet'); return; }
  showToast(`♥️ You have ${favs.length} saved post${favs.length !== 1 ? 's' : ''}`);
}

// ── PASSWORD / USERNAME MODAL OPENERS ─────────────────────────────────────

function openChangePassword() {
  openModal('change-password-modal');
}
function openChangePasswordModal() { openChangePassword(); }

// ── USER MENU TOGGLES ─────────────────────────────────────────────────────

function toggleUserMenu() {
  document.getElementById('user-menu-dropdown')?.classList.toggle('open');
}

function toggleSettingsMenu() {
  document.getElementById('settings-dropdown')?.classList.toggle('open');
}

// Close dropdowns on outside click
document.addEventListener('click', function (event) {
  const userDropdown    = document.getElementById('user-menu-dropdown');
  const userTrigger     = document.getElementById('login-menu-btn');
  const settingsDrop    = document.getElementById('settings-dropdown');
  const settingsTrigger = document.getElementById('user-menu-btn');

  if (userDropdown && userTrigger &&
      !userDropdown.contains(event.target) && !userTrigger.contains(event.target)) {
    userDropdown.classList.remove('open');
  }
  if (settingsDrop && settingsTrigger &&
      !settingsDrop.contains(event.target) && !settingsTrigger.contains(event.target)) {
    settingsDrop.classList.remove('open');
  }
});

// ── SESSION ───────────────────────────────────────────────────────────────

function clearSession() {
  location.reload();
}

// ── MODERATOR REQUEST MODAL ───────────────────────────────────────────────

function openRequestModModal() {
  const boardSelect = document.getElementById('request-mod-board');
  if (boardSelect) {
    boardSelect.innerHTML =
      '<option value="">Select a board...</option>' +
      forums.map(f => `<option value="${f.id}">${f.icon || '📌'} ${f.name}</option>`).join('');
  }
  openModal('request-mod-modal');
}

function submitModeratorRequest() {
  const boardId = document.getElementById('request-mod-board').value;
  const reason  = document.getElementById('request-mod-reason').value.trim();

  if (!authenticatedUser) { showToast('❌ Must be logged in'); return; }
  if (!boardId)           { showToast('Select a board'); return; }
  if (!reason)            { showToast('Tell us why you want to be a moderator'); return; }

  if (requestModeratorStatus(SESSION_NAME, boardId, reason)) {
    document.getElementById('request-mod-board').value  = '';
    document.getElementById('request-mod-reason').value = '';
    closeModal('request-mod-modal');
    showToast('✓ Moderator request submitted!');
  }
}

// ── ADMIN PANEL ───────────────────────────────────────────────────────────

function toggleAdminPanel() {
  openUserProfile();
}

function updateAdminProfileList() {
  const adminSection = document.getElementById('admin-section');
  if (!adminSection || adminSection.style.display === 'none') return;
  if (!authenticatedUser?.isAdmin) return;

  // Moderator requests
  const pending        = moderatorRequests.filter(r => r.status === 'pending');
  const countEl        = document.getElementById('admin-mod-requests-count');
  const listEl         = document.getElementById('admin-mod-requests-list');
  const noRequestsEl   = document.getElementById('admin-no-mod-requests');
  if (countEl) countEl.textContent = `${pending.length} pending`;

  if (pending.length === 0) {
    if (listEl)       listEl.innerHTML = '';
    if (noRequestsEl) noRequestsEl.style.display = 'block';
  } else {
    if (noRequestsEl) noRequestsEl.style.display = 'none';
    if (listEl) {
      listEl.innerHTML = pending.map(req => {
        const board = BOARDS[req.boardId];
        return `
          <div style="background:var(--bg);border:1px solid var(--border);padding:0.6rem;margin-bottom:0.4rem;border-radius:2px;font-size:0.75rem;">
            <div style="font-weight:600;color:var(--accent);margin-bottom:0.25rem;">${req.username}</div>
            <div style="color:var(--muted);margin-bottom:0.25rem;">📌 ${board?.name || req.boardId}</div>
            <div style="color:var(--text);margin-bottom:0.4rem;">"${req.reason.substring(0, 60)}${req.reason.length > 60 ? '…' : ''}"</div>
            <div style="display:flex;gap:0.25rem;">
              <button onclick="approveModRequest(${req.id})" style="flex:1;padding:0.3rem;background:var(--accent3);color:var(--bg);border:none;cursor:pointer;border-radius:2px;font-size:0.7rem;font-family:inherit;font-weight:600;">Approve</button>
              <button onclick="rejectModRequest(${req.id})"  style="flex:1;padding:0.3rem;background:var(--danger);color:var(--bg);border:none;cursor:pointer;border-radius:2px;font-size:0.7rem;font-family:inherit;font-weight:600;">Reject</button>
            </div>
          </div>`;
      }).join('');
    }
  }

  // Stats
  const el = id => document.getElementById(id);
  if (el('admin-profile-total-users'))  el('admin-profile-total-users').textContent  = allUsers.length;
  if (el('admin-profile-admin-count'))  el('admin-profile-admin-count').textContent  = allUsers.filter(u => u.isAdmin).length;
  if (el('admin-profile-total-forums')) el('admin-profile-total-forums').textContent = forums.length;
  if (el('admin-profile-total-posts'))  el('admin-profile-total-posts').textContent  = posts.length;
}

function approveModRequest(requestId) {
  const req = moderatorRequests.find(r => r.id === requestId);
  if (!req) return;
  if (approveModerator(requestId, SESSION_NAME)) {
    showToast(`✓ Approved ${req.username} as moderator`);
    updateAdminProfileList();
  }
}

function rejectModRequest(requestId) {
  const req = moderatorRequests.find(r => r.id === requestId);
  if (!req) return;
  const reason = prompt(`Reject request from ${req.username}?\n\nOptional reason:`, '');
  if (reason === null) return;
  if (rejectModerator(requestId, SESSION_NAME, reason)) {
    showToast(`✕ Rejected ${req.username}'s request`);
    updateAdminProfileList();
  }
}

function adminGrantAdmin() {
  const username = document.getElementById('admin-profile-manage-username')?.value.trim();
  if (!username) { showToast('Enter a username'); return; }

  const user = getUserByUsername(username);
  if (!user)        { showToast('User not found'); return; }
  if (user.isAdmin) { showToast(`${username} is already an admin`); return; }

  user.isAdmin = user.isSuperAdmin = true;
  saveUsersToDatabase(allUsers);
  document.getElementById('admin-profile-manage-username').value = '';
  showToast(`✓ ${username} is now an admin`);
  updateAdminProfileList();
}

function adminRevokeAdmin() {
  const username = document.getElementById('admin-profile-manage-username')?.value.trim();
  if (!username) { showToast('Enter a username'); return; }
  if (username === SESSION_NAME) { showToast('❌ Cannot revoke your own admin rights'); return; }

  const user = getUserByUsername(username);
  if (!user)         { showToast('User not found'); return; }
  if (!user.isAdmin) { showToast(`${username} is not an admin`); return; }

  user.isAdmin = user.isSuperAdmin = false;
  saveUsersToDatabase(allUsers);
  document.getElementById('admin-profile-manage-username').value = '';
  showToast(`✓ ${username}'s admin rights revoked`);
  updateAdminProfileList();
}

function adminChangeAnonID() {
  const usernameEl = document.getElementById('admin-change-anonid-username');
  const newIdEl    = document.getElementById('admin-change-anonid-new');
  const username   = usernameEl?.value.trim();
  const newAnonID  = newIdEl?.value.trim();

  if (!username) { showToast('Enter username'); return; }

  const user = getUserByUsername(username);
  if (!user) { showToast('User not found'); return; }

  if (newAnonID && !newAnonID.startsWith('ANON_')) {
    showToast('❌ ID must start with ANON_'); return;
  }

  const oldAnonID = user.anonID;
  user.anonID     = newAnonID || genAnonName();

  saveUsersToDatabase(allUsers);
  if (usernameEl) usernameEl.value = '';
  if (newIdEl)    newIdEl.value    = '';

  showToast(`✓ ${username}: ${oldAnonID} → ${user.anonID}`);
  updateAdminProfileList();
}
