// Leave 4% above the avatar and reserve enough room for the composer below it.
export function getDesktopAvatarFraming(bounds, fovDegrees, footerFraction = 0.12) {
  const height = bounds.max.y - bounds.min.y;
  const feetRatio = 1 - Math.max(0.12, Math.min(0.4, footerFraction));
  const visibleHeight = height / (feetRatio - 0.04);
  return {
    targetY: bounds.min.y + visibleHeight * (feetRatio - 0.5),
    distance: visibleHeight / (2 * Math.tan(fovDegrees * Math.PI / 360)) + Math.max(0, bounds.max.z),
  };
}
