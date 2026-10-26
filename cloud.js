(function () {
  'use strict';

  var config = window.QUANTITY_CLOUD_CONFIG || {};
  var app = window.QuantityApp;
  var client = null;
  var currentUser = null;
  var currentProfile = null;
  var authMode = 'login';
  var adminRows = [];
  var pendingSync = Object.create(null);
  var syncTimer = 0;
  var signingIn = false;

  var $ = function (selector) { return document.querySelector(selector); };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function fmt(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = 0;
    return (Math.round((number + Number.EPSILON) * 100) / 100).toFixed(2);
  }

  function setCloudState(state, text) {
    var dot = $('#cloudDot');
    var status = $('#authCloudStatus');
    if (dot) {
      dot.className = 'cloud-dot' + (state ? ' ' + state : '');
    }
    if (status) status.textContent = text || '';
  }

  function setAuthMessage(text, type) {
    var element = $('#authMessage');
    if (!element) return;
    element.textContent = text || '';
    element.className = 'auth-message' + (type ? ' ' + type : '');
  }

  function openAuthModal() {
    var modal = $('#authModal');
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    if (currentUser) {
      $('#authSignedOut').hidden = true;
      $('#authSignedIn').hidden = false;
      $('#authDisplayName').textContent = displayName();
      $('#authUserEmail').textContent = currentUser.email || '';
      setCloudState(isOnline() ? 'online' : '', isOnline() ? '云端已连接，记录会自动同步。' : '当前使用本地模式。');
    } else {
      $('#authSignedOut').hidden = false;
      $('#authSignedIn').hidden = true;
      setAuthMode(authMode);
      setTimeout(function () { $('#authEmail').focus(); }, 30);
    }
  }

  function closeAuthModal() {
    var modal = $('#authModal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    $('#authLoginTab').classList.toggle('active', authMode === 'login');
    $('#authRegisterTab').classList.toggle('active', authMode === 'register');
    $('#authNameField').hidden = authMode !== 'register';
    $('#authAdminCodeField').hidden = authMode !== 'register';
    $('#authSubmit').textContent = authMode === 'register' ? '注册并登录' : '登录';
    $('#authPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    $('#authTitle').textContent = authMode === 'register' ? '注册账号' : '账号登录';
    $('#authSubtitle').textContent = authMode === 'register'
      ? '创建账号后即可跨设备同步测量结果。'
      : '登录后，测量结果会安全同步到你的账号。';
    setAuthMessage('');
  }

  function displayName() {
    return (currentProfile && currentProfile.display_name) ||
      (currentUser && currentUser.user_metadata && (currentUser.user_metadata.display_name || currentUser.user_metadata.name)) ||
      (currentUser && currentUser.email) || '已登录';
  }

  function isOnline() {
    return !!(client && currentUser);
  }

  function updateAccountUi() {
    var button = $('#accountBtn');
    var text = $('#accountBtnText');
    if (button) button.classList.toggle('signed-in', !!currentUser);
    if (text) text.textContent = currentUser ? displayName() : '登录 / 注册';
    var adminButton = $('#adminBtn');
    var adminPanel = $('#adminPanel');
    var isAdmin = !!(currentProfile && currentProfile.role === 'admin');
    if (adminButton) adminButton.hidden = !isAdmin;
    if (adminPanel && !isAdmin) adminPanel.hidden = true;
  }

  function mapRemoteRecord(row) {
    var updated = Date.parse(row.updated_at || '') || Date.now();
    var created = Date.parse(row.created_at || '') || updated;
    return {
      id: row.local_id,
      name: row.name || '未命名单元',
      state: row.payload || {},
      created: created,
      updated: updated
    };
  }

  async function signedIn(user) {
    if (!client || !user || signingIn) return;
    if (currentUser && currentUser.id === user.id) return;
    signingIn = true;
    currentUser = user;
    setCloudState('syncing', '正在连接云端…');
    try {
      var profileResult = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (profileResult.error) throw profileResult.error;
      currentProfile = profileResult.data || {
        id: user.id,
        email: user.email || '',
        display_name: (user.user_metadata && (user.user_metadata.display_name || user.user_metadata.name)) || user.email || '测量员',
        role: 'tester'
      };

      var recordsResult = await client.from('measurement_records').select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });
      if (recordsResult.error) throw recordsResult.error;

      var remoteRecords = (recordsResult.data || []).map(mapRemoteRecord);
      var merged = app.enterCloudUser(user.id, remoteRecords);
      var remoteById = Object.create(null);
      remoteRecords.forEach(function (record) { remoteById[record.id] = record; });
      for (var i = 0; i < merged.length; i++) {
        var local = merged[i];
        var remote = remoteById[local.id];
        if (!remote || Number(local.updated || 0) > Number(remote.updated || 0) + 1000) {
          await upsertRecord(local);
        }
      }
      setCloudState('online', '云端已连接，记录会自动同步。');
      updateAccountUi();
      if (currentProfile.role === 'admin' && $('#adminPanel') && !$('#adminPanel').hidden) {
        await loadAdminData();
      }
    } catch (error) {
      console.error('[云端登录失败]', error);
      setCloudState('error', '云端连接失败：' + readableError(error));
      app.toast('登录成功，但云端数据读取失败');
      updateAccountUi();
    } finally {
      signingIn = false;
    }
  }

  function signedOut() {
    currentUser = null;
    currentProfile = null;
    adminRows = [];
    pendingSync = Object.create(null);
    app.leaveCloudUser();
    setCloudState('', '当前使用本地模式。');
    updateAccountUi();
  }

  function readableError(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    return error.message || error.error_description || error.msg || '请稍后重试';
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!client) {
      setAuthMessage('账号服务未加载，请检查网络后刷新页面。', 'error');
      return;
    }
    var email = ($('#authEmail').value || '').trim();
    var password = $('#authPassword').value || '';
    var name = ($('#authName').value || '').trim();
    var adminCode = ($('#authAdminCode').value || '').trim();
    var submit = $('#authSubmit');
    submit.disabled = true;
    setAuthMessage(authMode === 'register' ? '正在创建账号…' : '正在登录…');

    try {
      if (authMode === 'register') {
        if (!name) throw new Error('请填写姓名或显示名称。');
        var signUpResult = await client.auth.signUp({
          email: email,
          password: password,
          options: { data: { display_name: name, admin_code: adminCode } }
        });
        if (signUpResult.error) throw signUpResult.error;
        if (!signUpResult.data.session) {
          setAuthMessage('账号已创建。请先到邮箱确认，再返回这里登录。', 'ok');
          setAuthMode('login');
          return;
        }
        await signedIn(signUpResult.data.session.user);
      } else {
        var signInResult = await client.auth.signInWithPassword({ email: email, password: password });
        if (signInResult.error) throw signInResult.error;
        await signedIn(signInResult.data.user);
      }
      closeAuthModal();
      app.toast(authMode === 'register' ? '账号已创建，云端同步已开启' : '登录成功，云端同步已开启');
    } catch (error) {
      setAuthMessage(readableError(error), 'error');
    } finally {
      submit.disabled = false;
    }
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    closeAuthModal();
    app.toast('已退出登录，数据保留在本机');
  }

  async function upsertRecord(record) {
    if (!currentUser || !record || !record.id || !record.state) return;
    var result = await client.from('measurement_records').upsert({
      user_id: currentUser.id,
      local_id: record.id,
      name: record.name || '未命名单元',
      payload: record.state
    }, { onConflict: 'user_id,local_id' });
    if (result.error) throw result.error;
  }

  function queueSync(record) {
    if (!currentUser || !record || !record.id) return;
    pendingSync[record.id] = JSON.parse(JSON.stringify(record));
    setCloudState('syncing', '正在同步到云端…');
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 450);
  }

  async function flushSync() {
    if (!currentUser) return;
    var ids = Object.keys(pendingSync);
    if (!ids.length) return;
    var queue = pendingSync;
    pendingSync = Object.create(null);
    try {
      for (var i = 0; i < ids.length; i++) {
        if (queue[ids[i]]) await upsertRecord(queue[ids[i]]);
      }
      setCloudState('online', '云端已同步。');
    } catch (error) {
      console.error('[云端同步失败]', error);
      setCloudState('error', '同步失败：' + readableError(error));
      app.toast('云端同步失败，本地记录仍然安全');
    }
  }

  async function deleteRemoteRecords(ids) {
    if (!client || !currentUser || !ids || !ids.length) return;
    setCloudState('syncing', '正在同步删除…');
    var result = await client.from('measurement_records').delete()
      .eq('user_id', currentUser.id)
      .in('local_id', ids);
    if (result.error) {
      setCloudState('error', '删除同步失败：' + readableError(result.error));
      return;
    }
    setCloudState('online', '云端已同步。');
  }

  async function loadAdminData() {
    if (!client || !currentProfile || currentProfile.role !== 'admin') return;
    var recordsHost = $('#adminRecords');
    if (recordsHost) recordsHost.innerHTML = '<div class="admin-empty">正在读取全部账号的数据…</div>';
    try {
      var results = await Promise.all([
        client.from('profiles').select('id,email,display_name,role,created_at').order('created_at', { ascending: true }),
        client.from('measurement_records').select('*').order('updated_at', { ascending: false })
      ]);
      if (results[0].error) throw results[0].error;
      if (results[1].error) throw results[1].error;
      var profiles = results[0].data || [];
      var profileMap = Object.create(null);
      profiles.forEach(function (profile) { profileMap[profile.id] = profile; });
      adminRows = (results[1].data || []).map(function (row) {
        var record = mapRemoteRecord(row);
        var owner = profileMap[row.user_id] || { display_name: '未知账号', email: '', role: 'tester' };
        record.owner = owner;
        record.userId = row.user_id;
        record.updatedAt = row.updated_at;
        return record;
      });
      renderAdmin(profiles);
    } catch (error) {
      if (recordsHost) recordsHost.innerHTML = '<div class="admin-empty">读取失败：' + esc(readableError(error)) + '</div>';
    }
  }

  function renderAdmin(profiles) {
    var summaries = adminRows.map(function (record) {
      return { record: record, summary: app.summarizeRecord(record) };
    });
    var totalArea = summaries.reduce(function (sum, item) { return sum + item.summary.areaTotal; }, 0);
    $('#adminSummary').innerHTML =
      '<div class="admin-metric"><span>测试账号</span><strong>' + profiles.length + '</strong></div>' +
      '<div class="admin-metric"><span>测量单元</span><strong>' + adminRows.length + '</strong></div>' +
      '<div class="admin-metric"><span>累计铺贴面积</span><strong>' + fmt(totalArea) + ' m²</strong></div>';

    $('#adminUsers').innerHTML = profiles.length
      ? profiles.map(function (profile) {
        var count = adminRows.filter(function (record) { return record.userId === profile.id; }).length;
        return '<span class="admin-user-chip">' + esc(profile.display_name || profile.email || '未命名账号') +
          (profile.role === 'admin' ? ' · 主账号' : '') + ' · ' + count + ' 条</span>';
      }).join('')
      : '<span class="admin-user-chip">暂无账号</span>';

    $('#adminRecords').innerHTML = summaries.length
      ? summaries.map(function (item, index) {
        var record = item.record;
        var summary = item.summary;
        var owner = record.owner || {};
        var detailLines = summary.bases.map(function (base) {
          return '<div class="admin-detail-line"><span>' + esc(base.name) +
            (base.add || base.deduct ? '（增 ' + fmt(base.add) + ' / 扣 ' + fmt(base.deduct) + '）' : '') +
            '</span><strong>' + fmt(base.net) + ' m²</strong></div>';
        }).join('');
        return '<article class="admin-record">' +
          '<div class="admin-record-head"><div><b>' + esc(summary.projectName) + '</b>' +
          '<small>' + esc(owner.display_name || owner.email || '未知账号') +
          (summary.floor ? ' · ' + esc(summary.floor) : '') +
          ' · ' + new Date(record.updated || Date.now()).toLocaleString('zh-CN', { hour12: false }) + '</small></div>' +
          '<button class="record-open" type="button" data-admin-detail="' + index + '">查看明细</button></div>' +
          '<div class="admin-record-metrics"><span>地砖 ' + fmt(summary.floorNet) + ' m²</span>' +
          '<span>墙砖 ' + fmt(summary.wallNet) + ' m²</span>' +
          '<span>合计 ' + fmt(summary.areaTotal) + ' m²</span>' +
          '<span>建议 ' + (summary.buyPieces || '—') + ' 片</span></div>' +
          '<div class="admin-detail" id="adminDetail' + index + '" hidden>' +
          (detailLines || '<div class="admin-detail-line"><span>暂无分项尺寸</span><strong>0.00 m²</strong></div>') +
          '</div></article>';
      }).join('')
      : '<div class="admin-empty">暂无测量记录。测试账号保存单元后会显示在这里。</div>';
  }

  function exportAdminRecords() {
    if (!adminRows.length) {
      app.toast('暂无可导出的测量记录');
      return;
    }
    var records = adminRows.map(function (record) {
      var summary = app.summarizeRecord(record);
      var owner = (record.owner && (record.owner.display_name || record.owner.email)) || '未知账号';
      return {
        name: owner + ' · ' + summary.projectName + (summary.floor ? ' · ' + summary.floor : ''),
        state: record.state
      };
    });
    app.exportRecordList(records, '全部账号-测量汇总');
    app.toast('已导出全部账号的测量结果');
  }

  function bindUi() {
    $('#accountBtn').addEventListener('click', openAuthModal);
    $('#authClose').addEventListener('click', closeAuthModal);
    $('#authAccountClose').addEventListener('click', closeAuthModal);
    $('#authLoginTab').addEventListener('click', function () { setAuthMode('login'); });
    $('#authRegisterTab').addEventListener('click', function () { setAuthMode('register'); });
    $('#authForm').addEventListener('submit', submitAuth);
    $('#authSignOut').addEventListener('click', signOut);
    $('#authModal').addEventListener('click', function (event) {
      if (event.target === $('#authModal')) closeAuthModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeAuthModal();
    });

    $('#adminBtn').addEventListener('click', async function () {
      var panel = $('#adminPanel');
      panel.hidden = !panel.hidden;
      this.textContent = panel.hidden ? '主账号后台' : '收起主账号后台';
      if (!panel.hidden) {
        await loadAdminData();
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    $('#adminRefresh').addEventListener('click', loadAdminData);
    $('#adminExport').addEventListener('click', exportAdminRecords);
    $('#adminRecords').addEventListener('click', function (event) {
      var button = event.target.closest('[data-admin-detail]');
      if (!button) return;
      var detail = $('#adminDetail' + button.dataset.adminDetail);
      if (detail) detail.hidden = !detail.hidden;
    });

    window.addEventListener('quantity:recordSaved', function (event) {
      queueSync(event.detail);
    });
    window.addEventListener('quantity:recordDeleted', function (event) {
      deleteRemoteRecords(event.detail);
    });
  }

  async function init() {
    bindUi();
    if (!window.supabase || !config.url || !config.publishableKey) {
      setCloudState('error', '账号服务未加载，本地功能仍可使用。');
      updateAccountUi();
      return;
    }
    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    var sessionResult = await client.auth.getSession();
    if (sessionResult.data && sessionResult.data.session) {
      await signedIn(sessionResult.data.session.user);
    } else {
      setCloudState('', '当前使用本地模式。');
      updateAccountUi();
    }
    client.auth.onAuthStateChange(function (event, session) {
      setTimeout(function () {
        if (event === 'SIGNED_OUT') signedOut();
        else if (session && session.user) signedIn(session.user);
      }, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
