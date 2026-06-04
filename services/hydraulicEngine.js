const g = 9.81;
const DX = 200;
const DT = 10;

function trapezoidalArea(b, m, h) {
  return (b + m * h) * h;
}

function trapezoidalWettedPerimeter(b, m, h) {
  return b + 2 * h * Math.sqrt(1 + m * m);
}

function trapezoidalHydraulicRadius(b, m, h) {
  const A = trapezoidalArea(b, m, h);
  const P = trapezoidalWettedPerimeter(b, m, h);
  return P > 0 ? A / P : 0;
}

function manningDischarge(n, A, R, S) {
  if (R <= 0 || S <= 0) return 0;
  return (1 / n) * A * Math.pow(R, 2 / 3) * Math.sqrt(S);
}

function depthFromArea(b, m, A) {
  if (A <= 0) return 0.01;
  if (m === 0) return A / b;
  const disc = b * b + 4 * m * A;
  return (-b + Math.sqrt(disc)) / (2 * m);
}

function solveManningForDepth(n, b, m, Q, S, hGuess = 1.0, maxIter = 50, tol = 1e-6) {
  let h = hGuess;
  for (let i = 0; i < maxIter; i++) {
    const A = trapezoidalArea(b, m, h);
    const P = trapezoidalWettedPerimeter(b, m, h);
    const R = A / P;
    const Qcalc = (1 / n) * A * Math.pow(R, 2 / 3) * Math.sqrt(S);

    if (Math.abs(Qcalc - Q) < tol * Math.max(Q, 0.001)) return h;

    const dA_dh = b + 2 * m * h;
    const dP_dh = 2 * Math.sqrt(1 + m * m);
    const dR_dh = (dA_dh * P - A * dP_dh) / (P * P);
    const term = Math.pow(R, -1 / 3) * (2 / 3) * dR_dh;
    const dQ_dh = (1 / n) * Math.sqrt(S) * (dA_dh * Math.pow(R, 2 / 3) + A * term);

    if (Math.abs(dQ_dh) < 1e-10) break;
    h = h - (Qcalc - Q) / dQ_dh;
    if (h < 0.01) h = 0.01;
  }
  return h;
}

function calculateGateDischarge(gate, upstreamDepth, downstreamDepth) {
  const Cd = gate.discharge_coeff;
  const b = gate.gate_width;
  const e = gate.current_opening;

  if (e <= 0.001) return 0;
  if (upstreamDepth <= 0.01) return 0;

  const H_up = upstreamDepth;
  const H_down = Math.max(0, downstreamDepth || 0);

  if (H_up <= e * 1.05) return 0;

  let Q;
  if (H_down <= e * 0.7) {
    Q = Cd * b * e * Math.sqrt(2 * g * (H_up - e));
  } else {
    const diffHead = H_up - H_down;
    if (diffHead <= 0.001) return 0;
    Q = Cd * b * e * Math.sqrt(2 * g * diffHead);
  }

  return Math.max(0, Q);
}

function computeSteadyState(segments, gates, headwaterDepth, adjustedGates = {}) {
  const orderedSegments = [...segments].sort((a, b) => a.order_index - b.order_index);
  const result = {};

  let upstreamAbsLevel = headwaterDepth + orderedSegments[0].bottom_elevation;

  for (let segIdx = 0; segIdx < orderedSegments.length; segIdx++) {
    const seg = orderedSegments[segIdx];
    const sd = seg.siltation_depth || 0;
    const segGates = gates.filter(g => g.canal_segment_id === seg.id);
    const upstreamGate = segGates.find(g => g.position_on_segment <= 0.01);
    const divGates = gates.filter(g => g.type === 'diversion' && g.canal_segment_id === seg.id && g.position_on_segment > 0);

    if (sd >= seg.design_water_level) {
      const blockedLevel = upstreamAbsLevel - seg.bed_slope * seg.length;
      result[seg.id] = {
        flow: 0,
        diversionFlow: 0,
        throughFlow: 0,
        normalDepth: sd,
        effectiveDepth: 0,
        siltationDepth: sd,
        upstreamLevel: upstreamAbsLevel,
        downstreamLevel: blockedLevel,
        canalUpstream: sd,
        canalDownstream: sd - seg.bed_slope * seg.length
      };
      upstreamAbsLevel = blockedLevel;
      continue;
    }

    let Q;

    if (upstreamGate) {
      const gateToUse = adjustedGates[upstreamGate.id] || upstreamGate;
      const depthUpAboveSill = upstreamAbsLevel - seg.bottom_elevation;

      let hDownEffGuess = Math.max(0.1, (depthUpAboveSill - sd) * 0.6);
      let Qgate = 0;

      for (let iter = 0; iter < 30; iter++) {
        const actualDownDepth = hDownEffGuess + sd;
        Qgate = calculateGateDischarge(gateToUse, depthUpAboveSill, actualDownDepth);
        if (Qgate <= 0.001) {
          hDownEffGuess *= 0.8;
          if (hDownEffGuess < 0.1) { hDownEffGuess = 0.1; break; }
          continue;
        }
        const hNormalEff = solveManningForDepth(seg.manning_n, seg.bottom_width, seg.side_slope, Qgate, seg.bed_slope, hDownEffGuess);
        if (Math.abs(hNormalEff - hDownEffGuess) < 0.001) {
          hDownEffGuess = hNormalEff;
          break;
        }
        hDownEffGuess = hNormalEff;
      }

      Q = Qgate;
    } else {
      const depthUp = upstreamAbsLevel - seg.bottom_elevation;
      const effectiveDepthUp = depthUp - sd;
      if (effectiveDepthUp <= 0) {
        Q = 0;
      } else {
        const A = trapezoidalArea(seg.bottom_width, seg.side_slope, effectiveDepthUp);
        const R = trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effectiveDepthUp);
        Q = manningDischarge(seg.manning_n, A, R, seg.bed_slope);
      }
    }

    let QdivTotal = 0;
    const hNormalEffForDiv = Q > 0 ? solveManningForDepth(seg.manning_n, seg.bottom_width, seg.side_slope, Q, seg.bed_slope, 1.0) : 0;
    const hNormalActualForDiv = hNormalEffForDiv + sd;
    for (const divGate of divGates) {
      const gateToUse = adjustedGates[divGate.id] || divGate;
      const Qdiv = calculateGateDischarge(gateToUse, hNormalActualForDiv, Math.max(0, hNormalActualForDiv - 0.2));
      QdivTotal += Qdiv;
    }

    const Qthrough = Math.max(0, Q - QdivTotal);

    const hNormalEff = Q > 0 ? solveManningForDepth(seg.manning_n, seg.bottom_width, seg.side_slope, Q, seg.bed_slope, 1.0) : 0;
    const hNormalActual = hNormalEff + sd;

    const upLevel = seg.bottom_elevation + hNormalActual;
    const downLevel = upLevel - seg.bed_slope * seg.length;

    result[seg.id] = {
      flow: Q,
      diversionFlow: QdivTotal,
      throughFlow: Qthrough,
      normalDepth: hNormalActual,
      effectiveDepth: hNormalEff,
      siltationDepth: sd,
      upstreamLevel: upLevel,
      downstreamLevel: downLevel,
      canalUpstream: hNormalActual,
      canalDownstream: hNormalActual - seg.bed_slope * seg.length
    };

    upstreamAbsLevel = downLevel;
  }

  return result;
}

function createComputationalGrid(segments, gates) {
  const grid = [];
  const segmentGridMap = {};

  for (const seg of segments) {
    const nNodes = Math.ceil(seg.length / DX) + 1;
    const segGrid = [];

    for (let i = 0; i < nNodes; i++) {
      const x = Math.min(i * DX, seg.length);
      segGrid.push({
        x: x,
        h: 0,
        Q: 0,
        A: 0,
        R: 0,
        segmentId: seg.id,
        segment: seg,
        nodeIndex: i,
        totalNodes: nNodes
      });
    }

    segmentGridMap[seg.id] = segGrid;
    grid.push(...segGrid);
  }

  return { grid, segmentGridMap };
}

function initializeWaterLevels(grid, initialConditions, segments, headwaterDepth) {
  for (const node of grid) {
    const seg = node.segment;
    const sd = seg.siltation_depth || 0;
    const ic = initialConditions ? initialConditions[seg.id] : null;

    if (ic) {
      const hUp = ic.canalUpstream;
      const hDown = ic.canalDownstream;
      const frac = node.x / seg.length;
      node.h = hUp + (hDown - hUp) * frac;
    } else {
      node.h = seg.design_water_level * 0.6;
    }

    if (node.h < sd + 0.1) node.h = sd + 0.1;

    const effH = node.h - sd;
    if (effH > 0) {
      node.A = trapezoidalArea(seg.bottom_width, seg.side_slope, effH);
      node.R = trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effH);
      node.Q = manningDischarge(seg.manning_n, node.A, node.R, seg.bed_slope);
    } else {
      node.A = 0;
      node.R = 0;
      node.Q = 0;
    }
  }
}

function findDiversionGatesOnSegment(segmentId, gates) {
  return gates.filter(g => g.type === 'diversion' && g.canal_segment_id === segmentId && g.position_on_segment > 0);
}

function simulateStep(segmentGridMap, segments, gates, headwaterDepth, downstreamDepth, adjustedGates = {}) {
  const orderedSegments = [...segments].sort((a, b) => a.order_index - b.order_index);

  for (let segIdx = 0; segIdx < orderedSegments.length; segIdx++) {
    const seg = orderedSegments[segIdx];
    const sd = seg.siltation_depth || 0;
    const segGrid = segmentGridMap[seg.id];
    const segGates = gates.filter(g => g.canal_segment_id === seg.id);
    const divGates = findDiversionGatesOnSegment(seg.id, gates);
    const upstreamGate = segGates.find(g => g.position_on_segment <= 0.01);
    const S0 = seg.bed_slope;

    if (sd >= seg.design_water_level) {
      for (const node of segGrid) {
        node.h = sd;
        node.A = 0;
        node.R = 0;
        node.Q = 0;
      }
      continue;
    }

    let Qin;
    if (upstreamGate) {
      const gateToUse = adjustedGates[upstreamGate.id] || upstreamGate;
      let depthUpAboveSill;
      if (segIdx === 0) {
        depthUpAboveSill = headwaterDepth;
      } else {
        const prevSeg = orderedSegments[segIdx - 1];
        const prevSegGrid = segmentGridMap[prevSeg.id];
        const lastNodePrev = prevSegGrid[prevSegGrid.length - 1];
        const absLevelUp = lastNodePrev.h + prevSeg.bottom_elevation;
        depthUpAboveSill = absLevelUp - seg.bottom_elevation;
      }
      const depthDownAboveSill = segGrid[0].h;
      Qin = calculateGateDischarge(gateToUse, depthUpAboveSill, depthDownAboveSill);
    } else {
      if (segIdx === 0) {
        const effDepth = headwaterDepth - sd;
        if (effDepth <= 0) {
          Qin = 0;
        } else {
          Qin = manningDischarge(
            seg.manning_n,
            trapezoidalArea(seg.bottom_width, seg.side_slope, effDepth),
            trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effDepth),
            S0
          );
        }
      } else {
        const prevSeg = orderedSegments[segIdx - 1];
        const prevSegGrid = segmentGridMap[prevSeg.id];
        Qin = prevSegGrid[prevSegGrid.length - 1].Q;
      }
    }

    const effH0 = segGrid[0].h - sd;
    const Qout0 = effH0 > 0 ? manningDischarge(seg.manning_n, segGrid[0].A, segGrid[0].R, S0) : 0;
    const netInflow0 = Qin - Qout0;
    const dA0 = netInflow0 * DT / (DX / 2);
    const newA0 = segGrid[0].A + dA0;

    if (newA0 > 0.01) {
      const effHFromA = depthFromArea(seg.bottom_width, seg.side_slope, newA0);
      segGrid[0].h = Math.max(sd + 0.01, effHFromA + sd);
    }
    const effH0_new = segGrid[0].h - sd;
    if (effH0_new > 0) {
      segGrid[0].A = trapezoidalArea(seg.bottom_width, seg.side_slope, effH0_new);
      segGrid[0].R = trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effH0_new);
      segGrid[0].Q = manningDischarge(seg.manning_n, segGrid[0].A, segGrid[0].R, S0);
    } else {
      segGrid[0].A = 0;
      segGrid[0].R = 0;
      segGrid[0].Q = 0;
    }

    for (let i = 1; i < segGrid.length; i++) {
      const node = segGrid[i];
      const prevNode = segGrid[i - 1];

      const localDivGates = divGates.filter(g =>
        Math.abs(g.position_on_segment - node.x) < DX / 2
      );

      let qLateral = 0;
      for (const divGate of localDivGates) {
        const gateToUse = adjustedGates[divGate.id] || divGate;
        const Qdiv = calculateGateDischarge(gateToUse, node.h, Math.max(0, node.h - 0.2));
        qLateral -= Qdiv / DX;
      }

      const dQ_dx = (node.Q - prevNode.Q) / DX;
      const dA_dt = -dQ_dx + qLateral;
      const newA = node.A + dA_dt * DT;

      if (newA > 0.01) {
        const effHFromA = depthFromArea(seg.bottom_width, seg.side_slope, newA);
        node.h = Math.max(sd + 0.01, effHFromA + sd);
      } else {
        node.h = sd + 0.01;
      }

      const effH = node.h - sd;
      if (effH > 0) {
        node.A = trapezoidalArea(seg.bottom_width, seg.side_slope, effH);
        node.R = trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effH);
        node.Q = manningDischarge(seg.manning_n, node.A, node.R, S0);
      } else {
        node.A = 0;
        node.R = 0;
        node.Q = 0;
      }
    }

    if (segIdx === orderedSegments.length - 1) {
      const lastNode = segGrid[segGrid.length - 1];
      const prevNode = segGrid[segGrid.length - 2];
      const Q_in = prevNode.Q;
      const Q_out = lastNode.Q;
      const dV = (Q_in - Q_out) * DT;
      const effH = lastNode.h - sd;
      const topW = seg.bottom_width + 2 * seg.side_slope * Math.max(0.01, effH);
      const dh = dV / (topW * DX);
      lastNode.h = Math.max(sd + 0.01, lastNode.h + dh);
      const effH_new = lastNode.h - sd;
      if (effH_new > 0) {
        lastNode.A = trapezoidalArea(seg.bottom_width, seg.side_slope, effH_new);
        lastNode.R = trapezoidalHydraulicRadius(seg.bottom_width, seg.side_slope, effH_new);
        lastNode.Q = manningDischarge(seg.manning_n, lastNode.A, lastNode.R, S0);
      } else {
        lastNode.A = 0;
        lastNode.R = 0;
        lastNode.Q = 0;
      }
    }
  }
}

function runSimulation(segments, gates, initialConditions, numSteps, adjustedGates = {}, headwaterDepth = 2.5) {
  const orderedSegments = [...segments].sort((a, b) => a.order_index - b.order_index);
  const { grid, segmentGridMap } = createComputationalGrid(orderedSegments, gates);

  initializeWaterLevels(grid, initialConditions, orderedSegments, headwaterDepth);

  const results = [];

  for (let step = 0; step < numSteps; step++) {
    const lastSeg = orderedSegments[orderedSegments.length - 1];
    const lastSegGrid = segmentGridMap[lastSeg.id];
    const currentDownstreamDepth = lastSegGrid[lastSegGrid.length - 1].h;

    simulateStep(
      segmentGridMap, orderedSegments, gates,
      headwaterDepth, currentDownstreamDepth, adjustedGates
    );

    if (step % 6 === 0) {
      const snapshot = {};
      for (const seg of orderedSegments) {
        snapshot[seg.id] = segmentGridMap[seg.id].map(node => ({
          x: node.x,
          h: node.h + node.segment.bottom_elevation,
          Q: node.Q
        }));
      }
      snapshot.timestamp = step * DT;
      results.push(snapshot);
    }
  }

  return results;
}

function interpolateWaterLevelAtPoint(segmentGrid, distance, segment) {
  for (let i = 0; i < segmentGrid.length - 1; i++) {
    const n1 = segmentGrid[i];
    const n2 = segmentGrid[i + 1];
    if (distance >= n1.x && distance <= n2.x) {
      const frac = (distance - n1.x) / (n2.x - n1.x);
      return n1.h + (n2.h - n1.h) * frac;
    }
  }
  if (distance <= segmentGrid[0].x) return segmentGrid[0].h;
  return segmentGrid[segmentGrid.length - 1].h;
}

module.exports = {
  g,
  DX,
  DT,
  trapezoidalArea,
  trapezoidalWettedPerimeter,
  trapezoidalHydraulicRadius,
  manningDischarge,
  depthFromArea,
  solveManningForDepth,
  calculateGateDischarge,
  computeSteadyState,
  createComputationalGrid,
  initializeWaterLevels,
  simulateStep,
  runSimulation,
  interpolateWaterLevelAtPoint
};
