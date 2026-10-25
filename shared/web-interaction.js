const POINTER_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'lostpointercapture'
];

function isTouchLikePointer(event) {
  return event.pointerType === 'touch' || event.pointerType === 'pen';
}

/**
 * Attach touch/pen gaze and tap handling to a web canvas.
 * Mouse input is intentionally left to the existing desktop interaction.
 */
export function attachWebTouchInteraction({ element, onLook, onTouch, onEnd } = {}) {
  if (!element || typeof element.addEventListener !== 'function' || typeof element.removeEventListener !== 'function') {
    throw new TypeError('A pointer event target element is required');
  }
  if (typeof onLook !== 'function' || typeof onTouch !== 'function' || typeof onEnd !== 'function') {
    throw new TypeError('onLook, onTouch, and onEnd callbacks are required');
  }

  const activePointers = new Set();
  const capturedPointers = new Set();
  let gesturePointerId = null;
  let suppressUntilAllLifted = false;
  let gestureEnded = true;
  let touchHandled = false;
  let disposed = false;

  function callEnd() {
    if (gestureEnded) return;
    gestureEnded = true;
    onEnd();
  }

  function capturePointer(pointerId) {
    if (typeof element.setPointerCapture !== 'function') return;
    try {
      element.setPointerCapture(pointerId);
      capturedPointers.add(pointerId);
    } catch {
      // The pointer can become inactive while a browser dispatches its event.
    }
  }

  function releasePointer(pointerId) {
    if (!capturedPointers.delete(pointerId) || typeof element.releasePointerCapture !== 'function') return;
    try {
      if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointerup and pointercancel may release capture before this handler runs.
    }
  }

  function endPointer(pointerId) {
    if (!activePointers.delete(pointerId)) {
      releasePointer(pointerId);
      return;
    }

    if (gesturePointerId === pointerId) {
      gesturePointerId = null;
      callEnd();
    }
    releasePointer(pointerId);

    if (activePointers.size === 0) {
      gesturePointerId = null;
      suppressUntilAllLifted = false;
      gestureEnded = true;
    }
  }

  function handlePointerDown(event) {
    if (disposed || !isTouchLikePointer(event) || event.pointerId === undefined || event.pointerId === null) return;
    if (activePointers.has(event.pointerId)) return;

    const alreadyTrackingPointer = activePointers.size > 0;
    activePointers.add(event.pointerId);
    capturePointer(event.pointerId);

    if (!alreadyTrackingPointer && activePointers.size === 1 && event.isPrimary !== false) {
      suppressUntilAllLifted = false;
      gesturePointerId = event.pointerId;
      gestureEnded = false;
      onLook(event.clientX, event.clientY, true);
      touchHandled = onTouch(event.clientX, event.clientY) !== false;
      return;
    }

    suppressUntilAllLifted = true;
    if (gesturePointerId !== null) {
      gesturePointerId = null;
      callEnd();
    }
  }

  function handlePointerMove(event) {
    if (
      disposed ||
      !isTouchLikePointer(event) ||
      suppressUntilAllLifted ||
      event.pointerId !== gesturePointerId ||
      !activePointers.has(event.pointerId)
    ) return;
    onLook(event.clientX, event.clientY, true);
    if (!touchHandled) touchHandled = onTouch(event.clientX, event.clientY) !== false;
  }

  function handlePointerUp(event) {
    if (!disposed && isTouchLikePointer(event) && event.pointerId !== undefined && event.pointerId !== null) {
      endPointer(event.pointerId);
    }
  }

  element.addEventListener('pointerdown', handlePointerDown);
  element.addEventListener('pointermove', handlePointerMove);
  element.addEventListener('pointerup', handlePointerUp);
  element.addEventListener('pointercancel', handlePointerUp);
  element.addEventListener('lostpointercapture', handlePointerUp);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const eventName of POINTER_EVENTS) {
        const handler = eventName === 'pointerdown'
          ? handlePointerDown
          : eventName === 'pointermove'
            ? handlePointerMove
            : handlePointerUp;
        element.removeEventListener(eventName, handler);
      }
      const hadActiveGesture = gesturePointerId !== null;
      const pointersToRelease = [...capturedPointers];
      activePointers.clear();
      gesturePointerId = null;
      suppressUntilAllLifted = false;
      gestureEnded = true;
      for (const pointerId of pointersToRelease) releasePointer(pointerId);
      if (hadActiveGesture) onEnd();
    }
  };
}

