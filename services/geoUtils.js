const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}

function isValidCoordinate(lat, lon) {
  return typeof lat === 'number' && !isNaN(lat) && isFinite(lat) &&
         typeof lon === 'number' && !isNaN(lon) && isFinite(lon) &&
         lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
    return Infinity;
  }

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return EARTH_RADIUS_METERS * c;
}

function pointToSegmentDistance(pointLat, pointLon, segStartLat, segStartLon, segEndLat, segEndLon) {
  if (!isValidCoordinate(pointLat, pointLon) ||
      !isValidCoordinate(segStartLat, segStartLon) ||
      !isValidCoordinate(segEndLat, segEndLon)) {
    return Infinity;
  }

  const R = EARTH_RADIUS_METERS;
  
  const phi1 = toRadians(segStartLat);
  const lambda1 = toRadians(segStartLon);
  const phi2 = toRadians(segEndLat);
  const lambda2 = toRadians(segEndLon);
  const phi3 = toRadians(pointLat);
  const lambda3 = toRadians(pointLon);
  
  const y1 = Math.sin(phi1);
  const x1 = Math.cos(phi1) * Math.cos(lambda1);
  const z1 = Math.cos(phi1) * Math.sin(lambda1);
  
  const y2 = Math.sin(phi2);
  const x2 = Math.cos(phi2) * Math.cos(lambda2);
  const z2 = Math.cos(phi2) * Math.sin(lambda2);
  
  const y3 = Math.sin(phi3);
  const x3 = Math.cos(phi3) * Math.cos(lambda3);
  const z3 = Math.cos(phi3) * Math.sin(lambda3);
  
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  
  const segLengthSq = dx * dx + dy * dy + dz * dz;
  
  if (segLengthSq === 0) {
    return haversineDistance(pointLat, pointLon, segStartLat, segStartLon);
  }
  
  const t = (x3 - x1) * dx + (y3 - y1) * dy + (z3 - z1) * dz;
  const tNorm = t / segLengthSq;
  
  let closestX, closestY, closestZ;
  
  if (tNorm <= 0) {
    closestX = x1;
    closestY = y1;
    closestZ = z1;
  } else if (tNorm >= 1) {
    closestX = x2;
    closestY = y2;
    closestZ = z2;
  } else {
    closestX = x1 + tNorm * dx;
    closestY = y1 + tNorm * dy;
    closestZ = z1 + tNorm * dz;
  }
  
  const dot = closestX * x3 + closestY * y3 + closestZ * z3;
  const closestMag = Math.sqrt(closestX * closestX + closestY * closestY + closestZ * closestZ);
  const pointMag = Math.sqrt(x3 * x3 + y3 * y3 + z3 * z3);
  
  if (closestMag === 0 || pointMag === 0) {
    return 0;
  }
  
  const cosAngle = Math.max(-1, Math.min(1, dot / (closestMag * pointMag)));
  const centralAngle = Math.acos(cosAngle);
  
  return R * centralAngle;
}

function calculateTotalDistance(points) {
  if (!points || points.length < 2) return 0;
  
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineDistance(
      points[i].latitude,
      points[i].longitude,
      points[i + 1].latitude,
      points[i + 1].longitude
    );
  }
  return total;
}

module.exports = {
  haversineDistance,
  pointToSegmentDistance,
  calculateTotalDistance,
  isValidCoordinate,
  toRadians,
  toDegrees
};
