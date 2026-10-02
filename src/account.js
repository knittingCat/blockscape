import { api, accountsAvailable } from './api.js';
import { encodeWorld } from './world.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (sel, root = document) => root.querySelector(sel);

// ctx: { getWorld(), loadScene(text, opts), makeThumb(), toast(msg), getCloud(), setCloud(c) }
export async function initAccount(ctx) {
  const panel = $('#panel');
  const body = $('#panelBody');
  const accountBtn = $('#accountBtn');
  const galleryBtn = $('#galleryBtn');
  const cloudBtn = $('#cloudBtn');

  if (!(await accountsAvailable())) return; // plain static copy: keep the buttons hidden
  let user = null;
  for (const b of [accountBtn, galleryBtn, cloudBtn]) b.hidden = false;

  async function refreshMe() {
    user = (await api('GET', '/api/me')).user;
    $('span', accountBtn).textContent = user ? user.username : 'Sign in';
  }
  await refreshMe();

  // ---------- panel helpers ----------
  function open(html, { wide = false, full = false } = {}) {
    body.innerHTML = html;
    panel.classList.toggle('wide', wide);
    panel.classList.toggle('full', full);
    if (!panel.open) panel.showModal();
    return body;
  }
  const close = () => panel.open && panel.close();
  const fail = (el, err) => {
    el.textContent = err.message;
    el.hidden = false;
  };
  panel.addEventListener('click', (e) => {
    if (e.target === panel && !panel.classList.contains('full')) close(); // click on the backdrop
  });

  // ---------- sign in / create account ----------
  function authView({ mode = 'login', message = '', after = null, skippable = false } = {}) {
    const signup = mode === 'signup';
    const el = open(`
      <div class="authbrand">🧱 Blockscape</div>
      <h2>${signup ? 'Create an account' : 'Sign in'}</h2>
      ${message ? `<p class="hint">${esc(message)}</p>` : ''}
      <form id="authForm" autocomplete="on">
        <label>Username
          <input name="username" autocomplete="username" maxlength="20" required autocapitalize="none" spellcheck="false">
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" maxlength="200" required>
        </label>
        ${signup ? '<p class="hint">Use a made-up username, not your real name. 3–20 letters, numbers or underscores. Passwords need 8+ characters. There is no email, so write your password down — it can\'t be reset by email.</p>' : ''}
        <p class="error" id="authError" hidden></p>
        <div class="row">
          <button type="button" data-act="close">${skippable ? 'Continue without an account' : 'Cancel'}</button>
          <button type="submit" class="primary">${signup ? 'Create account' : 'Sign in'}</button>
        </div>
      </form>
      <p class="hint center">${signup ? 'Already have an account?' : 'New here?'} <button type="button" class="link" data-act="switch">${signup ? 'Sign in' : 'Create an account'}</button></p>`, { full: true });
    $('[name=username]', el).focus();
    $('[data-act=close]', el).onclick = close;
    $('[data-act=switch]', el).onclick = () => authView({ mode: signup ? 'login' : 'signup', message, after, skippable });
    $('#authForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('POST', signup ? '/api/signup' : '/api/login', { username: f.get('username'), password: f.get('password') });
        await refreshMe();
        ctx.toast(`Hi ${user.username}!`);
        close();
        if (after) after();
      } catch (err) {
        fail($('#authError', el), err);
      }
    };
  }

  const needSignIn = (message, after) => authView({ mode: 'login', message, after });

  // ---------- save online ----------
  function saveView() {
    const world = ctx.getWorld();
    const cloud = ctx.getCloud();
    const updating = cloud && cloud.mine;
    const el = open(`
      <h2>${updating ? 'Save changes online' : 'Save online'}</h2>
      <form id="saveForm">
        <label>Title <input name="title" maxlength="80" required value="${esc(updating ? cloud.title : world.meta.title || '')}" placeholder="e.g. Chapter 3: The Little House"></label>
        <fieldset>
          <legend>Who can see it?</legend>
          <label class="inline"><input type="radio" name="vis" value="private" ${updating && cloud.visibility === 'gallery' ? '' : 'checked'}> Only me</label>
          <label class="inline"><input type="radio" name="vis" value="gallery" ${updating && cloud.visibility === 'gallery' ? 'checked' : ''}> In my gallery (other signed-in users can look)</label>
        </fieldset>
        <label>Optional: a code people must enter to open this diorama
          <input name="code" maxlength="40" autocomplete="off" placeholder="${updating && cloud.hasCode ? 'Leave blank to keep the current code' : 'Leave blank for no code'}">
        </label>
        ${updating && cloud.hasCode ? '<label class="inline"><input type="checkbox" name="clearCode"> Remove the code</label>' : ''}
        <p class="error" id="saveError" hidden></p>
        <div class="row">
          <button type="button" data-act="close">Cancel</button>
          ${updating ? '<button type="submit" value="new">Save as a new one</button>' : ''}
          <button type="submit" value="save" class="primary">${updating ? 'Save changes' : 'Save'}</button>
        </div>
      </form>`);
    $('[data-act=close]', el).onclick = close;
    $('#saveForm', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const asNew = e.submitter && e.submitter.value === 'new';
      const code = (f.get('code') || '').trim();
      const payload = {
        id: updating && !asNew ? cloud.id : undefined,
        title: f.get('title'),
        data: await encodeWorld(world),
        thumb: ctx.makeThumb(),
        visibility: f.get('vis'),
      };
      if (code) payload.code = code;
      else if (f.get('clearCode')) payload.code = '';
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      try {
        const res = await api('POST', '/api/dioramas', payload);
        world.meta.title = payload.title;
        ctx.setCloud({ id: res.id, title: payload.title, mine: true, visibility: payload.visibility, hasCode: !!code || (updating && cloud.hasCode && !f.get('clearCode')) });
        ctx.toast(payload.visibility === 'gallery' ? 'Saved — it is in your gallery.' : 'Saved to your account.');
        close();
      } catch (err) {
        for (const b of el.querySelectorAll('button')) b.disabled = false;
        fail($('#saveError', el), err);
      }
    };
  }

  // ---------- opening dioramas ----------
  async function openDiorama(id) {
    try {
      const d = await api('GET', `/api/dioramas/${id}`);
      await ctx.loadScene(d.data, { shared: !d.mine, cloud: { id: d.id, title: d.title, owner: d.owner, mine: d.mine, visibility: d.visibility } });
      close();
    } catch (err) {
      if (err.data && err.data.locked === 'gallery') return unlockView({ kind: 'gallery', id: err.data.ownerId, owner: err.data.owner, then: () => openDiorama(id) });
      if (err.data && err.data.locked === 'diorama') return unlockView({ kind: 'diorama', id: err.data.id, owner: err.data.owner, then: () => openDiorama(id) });
      ctx.toast(err.message);
    }
  }

  function unlockView({ kind, id, owner, then }) {
    const el = open(`
      <h2>🔒 Code needed</h2>
      <p>${kind === 'gallery' ? `${esc(owner)}'s gallery` : `A diorama by ${esc(owner)}`} needs a code. Ask ${esc(owner)} for it.</p>
      <form id="unlockForm">
        <label>Code <input name="code" autocomplete="off" maxlength="40" required></label>
        <p class="error" id="unlockError" hidden></p>
        <div class="row"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Open</button></div>
      </form>`);
    $('[name=code]', el).focus();
    $('[data-act=close]', el).onclick = close;
    $('#unlockForm', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/unlock', { kind, id, code: new FormData(e.target).get('code') });
        then();
      } catch (err) {
        fail($('#unlockError', el), err);
      }
    };
  }

  const cards = (items, { mine = false } = {}) =>
    items.length
      ? `<div class="cards">${items
          .map(
            (d) => `<div class="dcard">
              <button class="dthumb" data-open="${d.id}" title="Open">${d.thumb ? `<img src="${esc(d.thumb)}" alt="">` : `<span>${d.locked ? '🔒' : '🧱'}</span>`}</button>
              <div class="dtitle">${d.locked ? '🔒 ' : ''}${esc(d.title)}</div>
              <div class="dmeta">${mine ? (d.visibility === 'gallery' ? '🖼️ In my gallery' : '🙈 Only me') + (d.hasCode ? ' · 🔒 code' : '') : `by <button class="link" data-user="${esc(d.owner)}">${esc(d.owner)}</button>`}</div>
              ${mine ? `<div class="dactions"><button data-open="${d.id}">Open</button><button data-del="${d.id}">Delete</button></div>` : ''}
            </div>`,
          )
          .join('')}</div>`
      : '<p class="hint">Nothing here yet.</p>';

  function wireCards(el) {
    el.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openDiorama(Number(b.dataset.open))));
    el.querySelectorAll('[data-user]').forEach((b) => (b.onclick = () => userGalleryView(b.dataset.user)));
  }

  // ---------- my dioramas ----------
  async function mineView() {
    open('<h2>My dioramas</h2><p class="hint">Loading…</p>', { wide: true });
    try {
      const { dioramas } = await api('GET', '/api/dioramas/mine');
      const el = open(
        `<h2>👤 ${esc(user.username)}${user.isAdmin ? ' <small>(admin)</small>' : ''}</h2>
        ${cards(dioramas, { mine: true })}
        <h3>Gallery code</h3>
        <p class="hint">${user.hasGalleryCode ? 'Your gallery needs a code to open.' : 'Anyone signed in can open your gallery.'} You can ask for a code so only people you tell can look.</p>
        <form id="codeForm" class="inlineform">
          <input name="code" maxlength="40" autocomplete="off" placeholder="New gallery code (3+ characters)">
          <button class="primary">Set code</button>
          ${user.hasGalleryCode ? '<button type="button" data-act="clear">Remove code</button>' : ''}
        </form>
        <p class="error" id="codeError" hidden></p>
        <div class="row"><button type="button" data-act="signout">Sign out</button><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      el.querySelectorAll('[data-del]').forEach(
        (b) =>
          (b.onclick = async () => {
            if (!confirm('Delete this diorama for good?')) return;
            try {
              await api('DELETE', `/api/dioramas/${b.dataset.del}`);
              if (ctx.getCloud() && String(ctx.getCloud().id) === b.dataset.del) ctx.setCloud(null);
              mineView();
            } catch (err) {
              ctx.toast(err.message);
            }
          }),
      );
      $('[data-act=close]', el).onclick = close;
      $('[data-act=signout]', el).onclick = async () => {
        await api('POST', '/api/logout', {});
        await refreshMe();
        ctx.setCloud(null);
        ctx.toast('Signed out.');
        close();
      };
      const setCode = async (code) => {
        try {
          await api('PUT', '/api/me/gallery-code', { code });
          await refreshMe();
          ctx.toast(code ? 'Gallery code set.' : 'Gallery code removed.');
          mineView();
        } catch (err) {
          fail($('#codeError', el), err);
        }
      };
      $('#codeForm', el).onsubmit = (e) => {
        e.preventDefault();
        setCode(new FormData(e.target).get('code'));
      };
      const clear = $('[data-act=clear]', el);
      if (clear) clear.onclick = () => setCode(null);
    } catch (err) {
      ctx.toast(err.message);
      close();
    }
  }

  // ---------- gallery ----------
  async function galleryView() {
    open('<h2>🖼️ Gallery</h2><p class="hint">Loading…</p>', { wide: true });
    try {
      const g = await api('GET', '/api/gallery');
      const el = open(
        `<h2>🖼️ Gallery</h2>
        <p class="hint">Dioramas other people chose to share. Be kind — use 🚩 Report if something isn't okay.</p>
        <h3>People</h3>
        <div class="chips">${g.members.length ? g.members.map((m) => `<button class="chip" data-user="${esc(m.username)}">${m.locked ? '🔒 ' : ''}${esc(m.username)} <small>${m.count}</small></button>`).join('') : '<span class="hint">No one has shared anything yet.</span>'}</div>
        <h3>Newest</h3>
        ${cards(g.recent)}
        <div class="row"><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      $('[data-act=close]', el).onclick = close;
    } catch (err) {
      ctx.toast(err.message);
      close();
    }
  }

  async function userGalleryView(username) {
    try {
      const g = await api('GET', `/api/gallery/${encodeURIComponent(username)}`);
      if (g.locked) return unlockView({ kind: 'gallery', id: g.ownerId, owner: g.owner, then: () => userGalleryView(username) });
      const el = open(
        `<h2>🖼️ ${esc(g.owner)}'s gallery</h2>${cards(g.dioramas)}
        <div class="row"><button type="button" data-act="back">← All galleries</button><button type="button" class="primary" data-act="close">Close</button></div>`,
        { wide: true },
      );
      wireCards(el);
      $('[data-act=back]', el).onclick = galleryView;
      $('[data-act=close]', el).onclick = close;
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  // ---------- report ----------
  function reportView(id, title) {
    const el = open(`
      <h2>🚩 Report</h2>
      <p>Tell us what's wrong with “${esc(title)}”. A person will look at it.</p>
      <form id="reportForm">
        <label>What is the problem? <input name="reason" maxlength="300" required autocomplete="off"></label>
        <p class="error" id="reportError" hidden></p>
        <div class="row"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Send report</button></div>
      </form>`);
    $('[data-act=close]', el).onclick = close;
    $('#reportForm', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/report', { dioramaId: id, reason: new FormData(e.target).get('reason') });
        ctx.toast('Thanks — your report was sent.');
        close();
      } catch (err) {
        fail($('#reportError', el), err);
      }
    };
  }

  // ---------- toolbar ----------
  accountBtn.onclick = () => (user ? mineView() : authView());
  galleryBtn.onclick = () => (user ? galleryView() : needSignIn('Sign in to see the gallery.', galleryView));
  cloudBtn.onclick = () => (user ? saveView() : needSignIn('Sign in to save your diorama online.', saveView));

  // Asked every time the site opens while nobody is signed in.
  function promptIfSignedOut() {
    if (user) return;
    authView({ mode: 'login', skippable: true, message: 'Sign in to save your dioramas online and see the class gallery — or skip this and just build.' });
  }

  return { promptIfSignedOut, report: (id, title) => (user ? reportView(id, title) : needSignIn('Sign in to send a report.', () => reportView(id, title))), isSignedIn: () => !!user };
}
