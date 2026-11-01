(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.CallCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function canAcceptConnection(currentPeerId, nextPeerId) {
    return !currentPeerId || currentPeerId === nextPeerId
  }

  function isAuthorizedCall(connectionPeerId, callPeerId) {
    return Boolean(connectionPeerId && callPeerId && connectionPeerId === callPeerId)
  }

  function shouldKeepOutgoingCall(localPeerId, remotePeerId) {
    return String(localPeerId) < String(remotePeerId)
  }

  function matchesCallCancellation(activeCallId, cancelledCallId) {
    return Boolean(activeCallId && cancelledCallId && activeCallId === cancelledCallId)
  }

  function clampMessage(value, maxLength) {
    const text = String(value || '').trim()
    return text && text.length <= maxLength ? text : ''
  }

  function trimRenderedMessages(messages, maxCount) {
    return messages.slice(-maxCount)
  }

  return {
    canAcceptConnection,
    isAuthorizedCall,
    shouldKeepOutgoingCall,
    matchesCallCancellation,
    clampMessage,
    trimRenderedMessages
  }
})
