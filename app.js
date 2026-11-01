const els = {
  statusDot: document.getElementById('statusDot'), statusText: document.getElementById('statusText'),
  hostCard: document.getElementById('hostCard'), shareCard: document.getElementById('shareCard'),
  joinCard: document.getElementById('joinCard'), connectedCard: document.getElementById('connectedCard'),
  createBtn: document.getElementById('createBtn'), copyBtn: document.getElementById('copyBtn'), shareBtn: document.getElementById('shareBtn'),
  joinBtn: document.getElementById('joinBtn'), invitePreview: document.getElementById('invitePreview'), peerLabel: document.getElementById('peerLabel'),
  endSessionBtn: document.getElementById('endSessionBtn'), voiceCallBtn: document.getElementById('voiceCallBtn'), clearBtn: document.getElementById('clearBtn'),
  messages: document.getElementById('messages'), systemNote: document.getElementById('systemNote'), input: document.getElementById('messageInput'), sendBtn: document.getElementById('sendBtn'),
  callDock: document.getElementById('callDock'), callLabel: document.getElementById('callLabel'), callTime: document.getElementById('callTime'), remoteAudio: document.getElementById('remoteAudio'),
  answerBtn: document.getElementById('answerBtn'), playAudioBtn: document.getElementById('playAudioBtn'),
  muteBtn: document.getElementById('muteBtn'), hangupBtn: document.getElementById('hangupBtn'), toast: document.getElementById('toast')
}

const MAX_MESSAGE_LENGTH = 4000
const MAX_RENDERED_MESSAGES = 200
let peer = null
let localPeerId = ''
let inviteTarget = new URL(location.href).searchParams.get('peer') || ''
let remotePeerId = inviteTarget
let inviteLink = ''
let connection = null
let mediaCall = null
let incomingCall = null
let localStream = null
let callStartedAt = 0
let callTimer = null
let muted = false
let mediaRequestToken = 0
let callPending = false
let callEstablished = false
let peerUiInitialized = false
let activeCallId = ''
const cancelledCallIds = new Map()

function setStatus(text, ready = false) {
  els.statusText.textContent = text
  els.statusDot.classList.toggle('ready', ready)
}

function showToast(message) {
  els.toast.textContent = message
  els.toast.classList.add('show')
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200)
}

function escapeHtml(value) {
  const span = document.createElement('span')
  span.textContent = String(value)
  return span.innerHTML
}

function scrollBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight })
}

function addMessage(side, text) {
  const row = document.createElement('div')
  row.className = `row ${side === 'me' ? 'me' : 'them'}`
  const avatar = `<div class="avatar ${side === 'me' ? 'self' : 'other'}">${side === 'me' ? '我' : '友'}</div>`
  const bubble = `<div class="bubble">${escapeHtml(text)}</div>`
  row.innerHTML = side === 'me' ? `${bubble}${avatar}` : `${avatar}${bubble}`
  els.messages.appendChild(row)
  const rendered = [...els.messages.querySelectorAll('.row')]
  const retained = new Set(CallCore.trimRenderedMessages(rendered, MAX_RENDERED_MESSAGES))
  rendered.filter(node => !retained.has(node)).forEach(node => node.remove())
  scrollBottom()
}

function addSystemNote(text) {
  els.systemNote.textContent = text
  scrollBottom()
}

function createInviteLink() {
  if (!localPeerId) return ''
  const url = new URL(location.origin + location.pathname)
  url.searchParams.set('peer', localPeerId)
  inviteLink = url.toString()
  els.invitePreview.textContent = inviteLink
  els.hostCard.hidden = true
  els.shareCard.hidden = false
  addSystemNote('邀请链接已生成，等待朋友加入。')
  return inviteLink
}

async function copyInvite() {
  const link = inviteLink || createInviteLink()
  try {
    await navigator.clipboard.writeText(link)
    showToast('邀请链接已复制')
  } catch {
    prompt('复制这个邀请链接', link)
  }
}

async function shareInvite() {
  const link = inviteLink || createInviteLink()
  if (!navigator.share) return copyInvite()
  try {
    await navigator.share({ title: '加入我的声聊', text: '打开链接和我实时聊天、语音通话', url: link })
  } catch (error) {
    if (error.name !== 'AbortError') copyInvite()
  }
}

function bindConnection(conn) {
  const currentPeerId = connection ? connection.peer : ''
  if (!CallCore.canAcceptConnection(currentPeerId, conn.peer) || (connection && connection !== conn)) {
    conn.close()
    showToast('当前会话只允许两个人')
    return
  }
  connection = conn
  remotePeerId = conn.peer
  const connectTimer = setTimeout(() => {
    if (connection !== conn || conn.open) return
    connection = null
    conn.close()
    showDisconnectedState('连接超时，请重试')
  }, 15000)
  conn.on('open', () => {
    clearTimeout(connectTimer)
    els.hostCard.hidden = true
    els.shareCard.hidden = true
    els.joinCard.hidden = true
    els.connectedCard.hidden = false
    els.peerLabel.textContent = `对方 ID：${remotePeerId.slice(0, 12)}…`
    els.input.disabled = false
    els.sendBtn.disabled = false
    els.voiceCallBtn.hidden = false
    setStatus('好友已连接', true)
    addSystemNote('连接成功，现在双方可以实时发送消息和语音通话。')
    els.input.focus()
  })
  conn.on('data', data => {
    if (data && data.type === 'call-cancel') {
      cancelPendingCallFromPeer(data.callId)
      return
    }
    if (!data || data.type !== 'text' || typeof data.text !== 'string') return
    const text = CallCore.clampMessage(data.text, MAX_MESSAGE_LENGTH)
    if (text) addMessage('them', text)
  })
  conn.on('close', () => {
    clearTimeout(connectTimer)
    if (connection !== conn) return
    connection = null
    onPeerLeft('对方已离开聊天')
  })
  conn.on('error', () => {
    clearTimeout(connectTimer)
    if (connection === conn && !conn.open) {
      connection = null
      showDisconnectedState('加入失败，请重试')
    }
    showToast('文字连接出现异常')
  })
}

function sendDataMessage() {
  const text = CallCore.clampMessage(els.input.value, MAX_MESSAGE_LENGTH)
  if (!text || !connection || !connection.open) return
  connection.send({ type: 'text', text, sentAt: Date.now() })
  addMessage('me', text)
  els.input.value = ''
  els.sendBtn.classList.remove('ready')
}

async function acquireLocalStream(token) {
  if (localStream && localStream.active) return localStream
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('浏览器不支持麦克风')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
  if (token !== mediaRequestToken) {
    stream.getTracks().forEach(track => track.stop())
    const error = new Error('麦克风请求已取消')
    error.name = 'AbortError'
    throw error
  }
  localStream = stream
  return stream
}

function normalizeCallId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : ''
}

function createCallId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function rememberCallCancellation(callId) {
  const now = Date.now()
  for (const [id, timestamp] of cancelledCallIds) {
    if (now - timestamp > 60000) cancelledCallIds.delete(id)
  }
  cancelledCallIds.set(callId, now)
  while (cancelledCallIds.size > 50) cancelledCallIds.delete(cancelledCallIds.keys().next().value)
}

function bindMediaCall(call, callId) {
  if (mediaCall && mediaCall !== call) mediaCall.close()
  mediaCall = call
  activeCallId = callId
  incomingCall = null
  callPending = false
  callEstablished = false
  remotePeerId = call.peer
  els.answerBtn.hidden = true
  els.answerBtn.disabled = false
  els.playAudioBtn.hidden = true
  els.muteBtn.hidden = false
  els.voiceCallBtn.disabled = true
  els.callLabel.textContent = '正在连接语音…'
  els.callDock.hidden = false
  call.on('stream', stream => {
    if (mediaCall !== call) return
    callEstablished = true
    els.remoteAudio.srcObject = stream
    els.remoteAudio.play().then(() => {
      els.playAudioBtn.hidden = true
    }).catch(() => {
      els.playAudioBtn.hidden = false
      showToast('请点击“播放声音”收听对方')
    })
    callStartedAt = Date.now()
    els.callLabel.textContent = '正在语音通话'
    clearInterval(callTimer)
    callTimer = setInterval(updateCallTime, 500)
    updateCallTime()
    setStatus('语音通话中', true)
  })
  call.on('close', () => { if (mediaCall === call) finishCall('通话已结束') })
  call.on('error', () => { if (mediaCall === call) finishCall('通话连接失败') })
}

async function startVoiceCall(targetId = remotePeerId) {
  if (!targetId || !peer || peer.destroyed || mediaCall || incomingCall || callPending) return
  if (!connection || !connection.open || connection.peer !== targetId) return
  callPending = true
  els.voiceCallBtn.disabled = true
  const token = ++mediaRequestToken
  try {
    const stream = await acquireLocalStream(token)
    if (token !== mediaRequestToken || !connection || !connection.open || connection.peer !== targetId) return
    const callId = createCallId()
    const call = peer.call(targetId, stream, { metadata: { callId } })
    bindMediaCall(call, callId)
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.name === 'NotAllowedError' ? '请允许麦克风权限' : (error.message || '无法发起通话'))
  } finally {
    if (token === mediaRequestToken && !mediaCall) {
      callPending = false
      els.voiceCallBtn.disabled = false
    }
  }
}

function handleIncomingCall(call) {
  const callId = normalizeCallId(call.metadata && call.metadata.callId)
  const connectedPeerId = connection && connection.open ? connection.peer : ''
  if (!callId || !CallCore.isAuthorizedCall(connectedPeerId, call.peer)) {
    call.close()
    return
  }
  if (cancelledCallIds.has(callId)) {
    cancelledCallIds.delete(callId)
    call.close()
    return
  }
  if (callEstablished || incomingCall) {
    call.close()
    return
  }
  if (mediaCall || callPending) {
    if (CallCore.shouldKeepOutgoingCall(localPeerId, call.peer)) {
      call.close()
      return
    }
    mediaRequestToken++
    callPending = false
    const outgoing = mediaCall
    mediaCall = null
    if (outgoing) outgoing.close()
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop())
      localStream = null
    }
  }
  incomingCall = call
  activeCallId = callId
  remotePeerId = call.peer
  els.callLabel.textContent = '对方正在呼叫你'
  els.callTime.textContent = '点击接听'
  els.answerBtn.hidden = false
  els.answerBtn.disabled = false
  els.playAudioBtn.hidden = true
  els.muteBtn.hidden = true
  els.callDock.hidden = false
  setStatus('收到语音呼叫', true)
  call.on('close', () => { if (incomingCall === call) finishCall('对方已取消呼叫') })
}

async function answerIncomingCall() {
  const call = incomingCall
  if (!call || callPending) return
  if (!connection || !connection.open || connection.peer !== call.peer) {
    call.close()
    finishCall('呼叫来源无效')
    return
  }
  callPending = true
  els.answerBtn.disabled = true
  const token = ++mediaRequestToken
  try {
    const stream = await acquireLocalStream(token)
    if (token !== mediaRequestToken || incomingCall !== call || !connection || !connection.open || connection.peer !== call.peer) return
    call.answer(stream)
    bindMediaCall(call, activeCallId)
  } catch (error) {
    if (error.name !== 'AbortError') {
      call.close()
      finishCall('未能接听')
      showToast(error.name === 'NotAllowedError' ? '需要麦克风权限才能接听' : '接听失败')
    }
  } finally {
    if (token === mediaRequestToken && !mediaCall) {
      callPending = false
      els.answerBtn.disabled = false
    }
  }
}

function updateCallTime() {
  const seconds = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000))
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
  els.callTime.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function finishCall(message) {
  mediaRequestToken++
  callPending = false
  callEstablished = false
  clearInterval(callTimer)
  callTimer = null
  els.remoteAudio.srcObject = null
  els.callDock.hidden = true
  els.answerBtn.hidden = true
  els.answerBtn.disabled = false
  els.playAudioBtn.hidden = true
  els.muteBtn.hidden = false
  els.callTime.textContent = '00:00'
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop())
    localStream = null
  }
  mediaCall = null
  incomingCall = null
  activeCallId = ''
  muted = false
  els.muteBtn.textContent = '麦克风'
  els.voiceCallBtn.disabled = false
  setStatus(connection && connection.open ? '好友已连接' : message, Boolean(connection && connection.open))
  addSystemNote(message)
}

function cancelPendingCallFromPeer(value) {
  const cancelledCallId = normalizeCallId(value)
  if (!cancelledCallId) return
  if (!CallCore.matchesCallCancellation(activeCallId, cancelledCallId)) {
    rememberCallCancellation(cancelledCallId)
    return
  }
  if (callEstablished || (!mediaCall && !incomingCall && !callPending)) return
  const active = mediaCall
  const ringing = incomingCall
  mediaCall = null
  incomingCall = null
  if (active) active.close()
  if (ringing) ringing.close()
  finishCall('对方已取消呼叫')
}

function hangUp() {
  const active = mediaCall
  const ringing = incomingCall
  const callId = activeCallId
  if (callId && connection && connection.open && ((active && !callEstablished) || ringing)) {
    connection.send({ type: 'call-cancel', callId })
  }
  mediaCall = null
  incomingCall = null
  if (active) active.close()
  if (ringing) ringing.close()
  finishCall('通话已挂断')
}

function playRemoteAudio() {
  els.remoteAudio.play().then(() => {
    els.playAudioBtn.hidden = true
  }).catch(() => showToast('浏览器仍阻止播放，请使用音频控件'))
}

function toggleMute() {
  if (!localStream) return
  muted = !muted
  localStream.getAudioTracks().forEach(track => { track.enabled = !muted })
  els.muteBtn.textContent = muted ? '取消静音' : '麦克风'
  showToast(muted ? '麦克风已静音' : '麦克风已开启')
}

function joinInvitation() {
  if (!remotePeerId || !peer || !localPeerId) return
  els.joinBtn.disabled = true
  setStatus('正在加入…')
  bindConnection(peer.connect(remotePeerId, { reliable: true }))
}

function showDisconnectedState(message) {
  els.connectedCard.hidden = true
  els.voiceCallBtn.hidden = true
  els.input.disabled = true
  els.sendBtn.disabled = true
  setStatus(message)
  addSystemNote(message)
  if (inviteTarget) {
    els.joinCard.hidden = false
    els.joinBtn.disabled = false
  } else {
    els.shareCard.hidden = false
  }
}

function onPeerLeft(message) {
  hangUp()
  showDisconnectedState(message)
}

function endSession() {
  hangUp()
  if (connection) {
    const conn = connection
    connection = null
    conn.close()
  }
  if (peer && !peer.destroyed) peer.destroy()
  peer = null
  localPeerId = ''
  remotePeerId = ''
  inviteTarget = ''
  inviteLink = ''
  peerUiInitialized = false
  history.replaceState(null, '', location.origin + location.pathname)
  els.shareCard.hidden = true
  els.joinCard.hidden = true
  els.connectedCard.hidden = true
  els.hostCard.hidden = false
  els.createBtn.disabled = true
  els.voiceCallBtn.hidden = true
  els.input.disabled = true
  els.sendBtn.disabled = true
  setStatus('正在创建新会话…')
  addSystemNote('上一会话已结束，旧邀请链接已经失效。')
  initializePeer()
}

function initializePeer() {
  if (!window.Peer) {
    setStatus('实时通信组件加载失败')
    showToast('请检查网络后刷新页面')
    return
  }
  const iceServers = [
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
  peer = new Peer(undefined, { debug: 1, config: { iceServers } })
  peer.on('open', id => {
    localPeerId = id
    setStatus('服务已就绪', true)
    if (peerUiInitialized) return
    peerUiInitialized = true
    if (inviteTarget) {
      els.hostCard.hidden = true
      els.joinCard.hidden = false
      els.joinBtn.disabled = false
      addSystemNote('收到朋友邀请，点击“加入聊天”开始。')
    } else {
      els.createBtn.disabled = false
    }
  })
  peer.on('connection', bindConnection)
  peer.on('call', handleIncomingCall)
  peer.on('disconnected', () => {
    setStatus('正在重新连接…')
    if (!peer.destroyed) peer.reconnect()
  })
  peer.on('error', error => {
    const messages = {
      'peer-unavailable': '对方当前不在线或链接已失效',
      network: '网络连接异常，请重试',
      'server-error': '通信服务暂时不可用'
    }
    const message = messages[error.type] || '连接出现异常'
    setStatus(message)
    showToast(message)
    els.joinBtn.disabled = false
  })
}

els.createBtn.addEventListener('click', createInviteLink)
els.copyBtn.addEventListener('click', copyInvite)
els.shareBtn.addEventListener('click', shareInvite)
els.joinBtn.addEventListener('click', joinInvitation)
els.sendBtn.addEventListener('click', sendDataMessage)
els.input.addEventListener('input', () => els.sendBtn.classList.toggle('ready', Boolean(els.input.value.trim())))
els.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendDataMessage()
  }
})
els.voiceCallBtn.addEventListener('click', () => startVoiceCall())
els.answerBtn.addEventListener('click', answerIncomingCall)
els.playAudioBtn.addEventListener('click', playRemoteAudio)
els.hangupBtn.addEventListener('click', hangUp)
els.muteBtn.addEventListener('click', toggleMute)
els.endSessionBtn.addEventListener('click', endSession)
els.clearBtn.addEventListener('click', () => {
  els.messages.querySelectorAll('.row').forEach(node => node.remove())
  addSystemNote('聊天内容已从本页清除。')
})
window.addEventListener('beforeunload', () => {
  if (connection) connection.close()
  if (mediaCall) mediaCall.close()
  if (incomingCall) incomingCall.close()
  if (localStream) localStream.getTracks().forEach(track => track.stop())
  if (peer && !peer.destroyed) peer.destroy()
})

initializePeer()
