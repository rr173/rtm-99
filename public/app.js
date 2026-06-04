class ChannelSectionCalculator {
    constructor() {
        this.sectionCanvas = document.getElementById('sectionCanvas');
        this.sectionCtx = this.sectionCanvas.getContext('2d');
        this.ratingCanvas = document.getElementById('ratingCurveCanvas');
        this.ratingCtx = this.ratingCanvas.getContext('2d');
        
        this.scale = 50;
        this.offsetX = 100;
        this.offsetY = 400;
        
        this.vertices = [];
        this.isDrawing = false;
        this.isClosed = false;
        this.isValid = true;
        
        this.currentDepth = 1.5;
        this.n = 0.025;
        this.S = 0.0003;
        
        this.schemes = [];
        this.currentSchemeId = null;
        this.maxSchemes = 5;
        
        this.draggingIndex = -1;
        
        this.curveColors = ['#2196F3', '#F44336', '#4CAF50', '#FF9800', '#9C27B0'];
        
        this.init();
    }
    
    init() {
        this.bindEvents();
        this.loadPreset('trapezoid');
        this.updateSliderMax();
        this.calculateAndUpdate();
    }
    
    bindEvents() {
        this.sectionCanvas.addEventListener('click', (e) => this.handleClick(e));
        this.sectionCanvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
        this.sectionCanvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.sectionCanvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.sectionCanvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.sectionCanvas.addEventListener('contextmenu', (e) => this.handleRightClick(e));
        
        document.getElementById('depthSlider').addEventListener('input', (e) => {
            this.currentDepth = parseFloat(e.target.value);
            document.getElementById('depthValue').textContent = this.currentDepth.toFixed(2);
            this.updateSliderBackground();
            this.calculateAndUpdate();
        });
        
        document.getElementById('roughnessN').addEventListener('input', (e) => {
            this.n = parseFloat(e.target.value) || 0.025;
            this.calculateAndUpdate();
        });
        
        document.getElementById('slopeS').addEventListener('input', (e) => {
            this.S = parseFloat(e.target.value) || 0.0003;
            this.calculateAndUpdate();
        });
        
        document.getElementById('scaleInput').addEventListener('input', (e) => {
            this.scale = parseFloat(e.target.value) || 50;
            this.drawSection();
        });
        
        document.querySelectorAll('.btn-preset[data-preset]').forEach(btn => {
            btn.addEventListener('click', () => this.loadPreset(btn.dataset.preset));
        });
        
        document.getElementById('clearBtn').addEventListener('click', () => this.clearSection());
        
        document.getElementById('saveSchemeBtn').addEventListener('click', () => this.showSaveModal());
        document.getElementById('confirmSaveBtn').addEventListener('click', () => this.saveScheme());
        document.getElementById('cancelSaveBtn').addEventListener('click', () => this.hideSaveModal());
        
        document.getElementById('exportBtn').addEventListener('click', () => this.exportJSON());
        document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
        document.getElementById('importFile').addEventListener('change', (e) => this.importJSON(e));
    }
    
    getCanvasCoords(e) {
        const rect = this.sectionCanvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }
    
    toWorld(canvasX, canvasY) {
        return {
            x: (canvasX - this.offsetX) / this.scale,
            y: (this.offsetY - canvasY) / this.scale
        };
    }
    
    toCanvas(worldX, worldY) {
        return {
            x: worldX * this.scale + this.offsetX,
            y: this.offsetY - worldY * this.scale
        };
    }
    
    handleClick(e) {
        if (this.draggingIndex >= 0) return;
        
        const coords = this.getCanvasCoords(e);
        const world = this.toWorld(coords.x, coords.y);
        
        const vertexIndex = this.findVertexAt(coords.x, coords.y);
        if (vertexIndex >= 0) return;
        
        if (!this.isClosed) {
            this.vertices.push({ x: world.x, y: world.y });
            this.isDrawing = true;
            this.validateSection();
            this.drawSection();
        }
    }
    
    handleDoubleClick(e) {
        if (this.vertices.length >= 3) {
            this.closeSection();
        }
    }
    
    handleMouseDown(e) {
        if (e.button !== 0) return;
        
        const coords = this.getCanvasCoords(e);
        const vertexIndex = this.findVertexAt(coords.x, coords.y);
        
        if (vertexIndex >= 0) {
            this.draggingIndex = vertexIndex;
            this.sectionCanvas.style.cursor = 'grabbing';
        }
    }
    
    handleMouseMove(e) {
        const coords = this.getCanvasCoords(e);
        
        if (this.draggingIndex >= 0) {
            const world = this.toWorld(coords.x, coords.y);
            this.vertices[this.draggingIndex] = { x: world.x, y: world.y };
            this.validateSection();
            this.drawSection();
            this.calculateAndUpdate();
        } else {
            const vertexIndex = this.findVertexAt(coords.x, coords.y);
            this.sectionCanvas.style.cursor = vertexIndex >= 0 ? 'grab' : 'crosshair';
        }
    }
    
    handleMouseUp(e) {
        if (this.draggingIndex >= 0) {
            this.draggingIndex = -1;
            this.sectionCanvas.style.cursor = 'crosshair';
        }
    }
    
    handleRightClick(e) {
        e.preventDefault();
        
        const coords = this.getCanvasCoords(e);
        const vertexIndex = this.findVertexAt(coords.x, coords.y);
        
        if (vertexIndex >= 0 && this.vertices.length > 3) {
            this.vertices.splice(vertexIndex, 1);
            if (this.isClosed) {
                this.validateSection();
            }
            this.drawSection();
            this.calculateAndUpdate();
        }
    }
    
    findVertexAt(canvasX, canvasY) {
        const threshold = 8;
        for (let i = 0; i < this.vertices.length; i++) {
            const canvas = this.toCanvas(this.vertices[i].x, this.vertices[i].y);
            const dist = Math.sqrt((canvas.x - canvasX) ** 2 + (canvas.y - canvasY) ** 2);
            if (dist < threshold) {
                return i;
            }
        }
        return -1;
    }
    
    closeSection() {
        if (this.vertices.length >= 3) {
            this.isClosed = true;
            this.validateSection();
            this.updateSliderMax();
            this.calculateAndUpdate();
            this.drawSection();
        }
    }
    
    validateSection() {
        if (this.vertices.length < 3) {
            this.isValid = true;
            this.hideError();
            return;
        }
        
        const leftmost = this.vertices.reduce((min, v) => v.x < min.x ? v : min, this.vertices[0]);
        const rightmost = this.vertices.reduce((max, v) => v.x > max.x ? v : max, this.vertices[0]);
        
        const leftIdx = this.vertices.indexOf(leftmost);
        const rightIdx = this.vertices.indexOf(rightmost);
        
        let orderedVertices;
        if (leftIdx < rightIdx) {
            orderedVertices = this.vertices.slice(leftIdx, rightIdx + 1);
        } else {
            orderedVertices = [...this.vertices.slice(leftIdx), ...this.vertices.slice(0, rightIdx + 1)];
        }
        
        const leftTop = orderedVertices[0];
        const rightTop = orderedVertices[orderedVertices.length - 1];
        const minY = Math.min(...orderedVertices.map(v => v.y));
        
        this.isValid = leftTop.y >= minY && rightTop.y >= minY;
        
        if (!this.isValid) {
            this.showError();
        } else {
            this.hideError();
        }
    }
    
    showError() {
        document.getElementById('errorMessage').classList.remove('hidden');
    }
    
    hideError() {
        document.getElementById('errorMessage').classList.add('hidden');
    }
    
    getMaxDepth() {
        if (this.vertices.length < 2) return 3;
        const minY = Math.min(...this.vertices.map(v => v.y));
        const maxY = Math.max(...this.vertices.map(v => v.y));
        return Math.max(0.1, maxY - minY);
    }
    
    updateSliderMax() {
        const maxDepth = this.getMaxDepth();
        const slider = document.getElementById('depthSlider');
        slider.max = maxDepth.toFixed(2);
        if (this.currentDepth > maxDepth) {
            this.currentDepth = maxDepth / 2;
            slider.value = this.currentDepth;
            document.getElementById('depthValue').textContent = this.currentDepth.toFixed(2);
        }
        this.updateSliderBackground();
    }
    
    updateSliderBackground() {
        const slider = document.getElementById('depthSlider');
        const percent = (slider.value - slider.min) / (slider.max - slider.min) * 100;
        slider.style.background = `linear-gradient(to right, #2196F3 0%, #2196F3 ${percent}%, #ddd ${percent}%, #ddd 100%)`;
    }
    
    loadPreset(type) {
        this.vertices = [];
        this.isClosed = false;
        this.isDrawing = false;
        
        switch (type) {
            case 'trapezoid':
                const bottomWidth = 6;
                const depth = 3;
                const slope = 1.5;
                const topWidth = bottomWidth + 2 * slope * depth;
                this.vertices = [
                    { x: -topWidth / 2, y: depth },
                    { x: -bottomWidth / 2, y: 0 },
                    { x: bottomWidth / 2, y: 0 },
                    { x: topWidth / 2, y: depth }
                ];
                break;
                
            case 'rectangle':
                const width = 5;
                const rectDepth = 3;
                this.vertices = [
                    { x: -width / 2, y: rectDepth },
                    { x: -width / 2, y: 0 },
                    { x: width / 2, y: 0 },
                    { x: width / 2, y: rectDepth }
                ];
                break;
                
            case 'ushape':
                const radius = 2;
                const segments = 20;
                for (let i = 0; i <= segments; i++) {
                    const angle = Math.PI + (i / segments) * Math.PI;
                    this.vertices.push({
                        x: radius * Math.cos(angle),
                        y: radius + radius * Math.sin(angle)
                    });
                }
                break;
                
            case 'compound':
                const mainBottom = 4;
                const mainDepth = 2;
                const mainSlope = 1;
                const benchWidth = 3;
                const bankHeight = 1.5;
                const bankSlope = 1.5;
                
                const mainTop = mainBottom + 2 * mainSlope * mainDepth;
                const totalTop = mainTop + 2 * benchWidth + 2 * bankSlope * bankHeight;
                
                this.vertices = [
                    { x: -totalTop / 2, y: mainDepth + bankHeight },
                    { x: -mainTop / 2 - benchWidth, y: mainDepth },
                    { x: -mainTop / 2, y: mainDepth },
                    { x: -mainBottom / 2, y: 0 },
                    { x: mainBottom / 2, y: 0 },
                    { x: mainTop / 2, y: mainDepth },
                    { x: mainTop / 2 + benchWidth, y: mainDepth },
                    { x: totalTop / 2, y: mainDepth + bankHeight }
                ];
                break;
        }
        
        this.closeSection();
    }
    
    clearSection() {
        this.vertices = [];
        this.isClosed = false;
        this.isDrawing = false;
        this.isValid = true;
        this.currentDepth = 0;
        this.hideError();
        this.drawSection();
        this.updateParams({ area: 0, wettedPerimeter: 0, hydraulicRadius: 0, surfaceWidth: 0, discharge: 0 });
        this.drawRatingCurve();
    }
    
    calculateHydraulics(depth) {
        if (!this.isClosed || !this.isValid || this.vertices.length < 3 || depth <= 0) {
            return { area: 0, wettedPerimeter: 0, hydraulicRadius: 0, surfaceWidth: 0, discharge: 0 };
        }
        
        const minY = Math.min(...this.vertices.map(v => v.y));
        const waterLevel = minY + depth;
        
        const wettedPoints = [];
        let area = 0;
        let wettedPerimeter = 0;
        let surfaceWidth = 0;
        
        let leftIntersection = null;
        let rightIntersection = null;
        
        for (let i = 0; i < this.vertices.length; i++) {
            const p1 = this.vertices[i];
            const p2 = this.vertices[(i + 1) % this.vertices.length];
            
            const y1 = p1.y - minY;
            const y2 = p2.y - minY;
            
            const isP1Wetted = y1 <= depth + 0.0001;
            const isP2Wetted = y2 <= depth + 0.0001;
            
            if (isP1Wetted && isP2Wetted) {
                if (wettedPoints.length === 0 || wettedPoints[wettedPoints.length - 1].x !== p1.x) {
                    wettedPoints.push(p1);
                }
                wettedPoints.push(p2);
                wettedPerimeter += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
            } else if (isP1Wetted || isP2Wetted) {
                const intersection = this.lineIntersectY(p1, p2, waterLevel);
                if (intersection) {
                    if (isP1Wetted) {
                        wettedPoints.push(p1);
                        wettedPerimeter += Math.sqrt((intersection.x - p1.x) ** 2 + (intersection.y - p1.y) ** 2);
                    } else {
                        wettedPerimeter += Math.sqrt((intersection.x - p2.x) ** 2 + (intersection.y - p2.y) ** 2);
                        wettedPoints.push(p2);
                    }
                    wettedPoints.push(intersection);
                    
                    if (!leftIntersection || intersection.x < leftIntersection.x) {
                        leftIntersection = intersection;
                    }
                    if (!rightIntersection || intersection.x > rightIntersection.x) {
                        rightIntersection = intersection;
                    }
                }
            }
        }
        
        if (leftIntersection && rightIntersection) {
            surfaceWidth = rightIntersection.x - leftIntersection.x;
            
            if (wettedPoints.length >= 2) {
                const sortedPoints = wettedPoints.sort((a, b) => a.x - b.x);
                for (let i = 0; i < sortedPoints.length - 1; i++) {
                    const p1 = sortedPoints[i];
                    const p2 = sortedPoints[i + 1];
                    const avgHeight = (waterLevel - p1.y + waterLevel - p2.y) / 2;
                    area += avgHeight * (p2.x - p1.x);
                }
            }
        }
        
        if (wettedPoints.length >= 3) {
            area = 0;
            const ordered = [...wettedPoints].sort((a, b) => a.x - b.x);
            for (let i = 0; i < ordered.length - 1; i++) {
                const y1 = waterLevel - ordered[i].y;
                const y2 = waterLevel - ordered[i + 1].y;
                area += (y1 + y2) * (ordered[i + 1].x - ordered[i].x) / 2;
            }
        }
        
        const hydraulicRadius = wettedPerimeter > 0 ? area / wettedPerimeter : 0;
        const discharge = (1 / this.n) * area * Math.pow(hydraulicRadius, 2/3) * Math.sqrt(this.S);
        
        return { area, wettedPerimeter, hydraulicRadius, surfaceWidth, discharge };
    }
    
    lineIntersectY(p1, p2, y) {
        if (Math.abs(p2.y - p1.y) < 0.0001) return null;
        
        const t = (y - p1.y) / (p2.y - p1.y);
        if (t >= -0.001 && t <= 1.001) {
            return {
                x: p1.x + t * (p2.x - p1.x),
                y: y
            };
        }
        return null;
    }
    
    calculateAndUpdate() {
        const result = this.calculateHydraulics(this.currentDepth);
        this.updateParams(result);
        this.drawSection();
        this.drawRatingCurve();
    }
    
    updateParams(result) {
        document.getElementById('areaValue').textContent = result.area.toFixed(2);
        document.getElementById('wettedPerimeterValue').textContent = result.wettedPerimeter.toFixed(2);
        document.getElementById('hydraulicRadiusValue').textContent = result.hydraulicRadius.toFixed(3);
        document.getElementById('surfaceWidthValue').textContent = result.surfaceWidth.toFixed(2);
        document.getElementById('dischargeValue').textContent = result.discharge.toFixed(2);
    }
    
    drawSection() {
        const ctx = this.sectionCtx;
        ctx.clearRect(0, 0, this.sectionCanvas.width, this.sectionCanvas.height);
        
        this.drawGrid();
        
        if (this.vertices.length < 2) return;
        
        const minY = Math.min(...this.vertices.map(v => v.y));
        const waterLevel = minY + this.currentDepth;
        
        if (this.isClosed && this.isValid && this.currentDepth > 0) {
            this.drawWaterFill(waterLevel);
        }
        
        ctx.beginPath();
        const first = this.toCanvas(this.vertices[0].x, this.vertices[0].y);
        ctx.moveTo(first.x, first.y);
        
        for (let i = 1; i < this.vertices.length; i++) {
            const p = this.toCanvas(this.vertices[i].x, this.vertices[i].y);
            ctx.lineTo(p.x, p.y);
        }
        
        if (this.isClosed) {
            ctx.closePath();
        }
        
        ctx.strokeStyle = this.isValid ? '#1976D2' : '#F44336';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        if (this.isClosed && this.isValid && this.currentDepth > 0) {
            this.drawWaterLine(waterLevel);
        }
        
        this.vertices.forEach((v, i) => {
            const p = this.toCanvas(v.x, v.y);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = this.draggingIndex === i ? '#FF5722' : '#FFC107';
            ctx.fill();
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;
            ctx.stroke();
        });
        
        this.drawAxes();
    }
    
    drawGrid() {
        const ctx = this.sectionCtx;
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        
        for (let x = 0; x < this.sectionCanvas.width; x += this.scale) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.sectionCanvas.height);
            ctx.stroke();
        }
        
        for (let y = 0; y < this.sectionCanvas.height; y += this.scale) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(this.sectionCanvas.width, y);
            ctx.stroke();
        }
    }
    
    drawAxes() {
        const ctx = this.sectionCtx;
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 2;
        ctx.fillStyle = '#666';
        ctx.font = '12px Arial';
        
        ctx.beginPath();
        ctx.moveTo(this.offsetX, 0);
        ctx.lineTo(this.offsetX, this.sectionCanvas.height);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(0, this.offsetY);
        ctx.lineTo(this.sectionCanvas.width, this.offsetY);
        ctx.stroke();
        
        ctx.fillText('宽度 (m)', this.sectionCanvas.width - 60, this.offsetY + 20);
        ctx.save();
        ctx.translate(15, 50);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('深度 (m)', 0, 0);
        ctx.restore();
        
        for (let i = -2; i <= 10; i++) {
            const p = this.toCanvas(i, 0);
            ctx.fillText(i.toString(), p.x - 5, this.offsetY + 18);
        }
        
        for (let i = 0; i <= 8; i++) {
            const p = this.toCanvas(0, i);
            ctx.fillText(i.toString(), this.offsetX - 20, p.y + 4);
        }
    }
    
    drawWaterFill(waterLevel) {
        const ctx = this.sectionCtx;
        const intersections = [];
        
        for (let i = 0; i < this.vertices.length; i++) {
            const p1 = this.vertices[i];
            const p2 = this.vertices[(i + 1) % this.vertices.length];
            
            const inter = this.lineIntersectY(p1, p2, waterLevel);
            if (inter) {
                intersections.push(inter);
            }
        }
        
        if (intersections.length >= 2) {
            intersections.sort((a, b) => a.x - b.x);
            
            const wettedPoints = [];
            for (let i = 0; i < this.vertices.length; i++) {
                if (this.vertices[i].y <= waterLevel + 0.001) {
                    wettedPoints.push(this.vertices[i]);
                }
            }
            
            ctx.beginPath();
            ctx.fillStyle = 'rgba(33, 150, 243, 0.4)';
            
            const leftInter = intersections[0];
            const rightInter = intersections[intersections.length - 1];
            
            const leftCanvas = this.toCanvas(leftInter.x, leftInter.y);
            const rightCanvas = this.toCanvas(rightInter.x, rightInter.y);
            
            ctx.moveTo(leftCanvas.x, leftCanvas.y);
            
            const belowPoints = this.vertices.filter(v => v.y <= waterLevel + 0.001);
            belowPoints.sort((a, b) => a.x - b.x);
            
            for (const p of belowPoints) {
                if (p.x >= leftInter.x && p.x <= rightInter.x) {
                    const canvas = this.toCanvas(p.x, p.y);
                    ctx.lineTo(canvas.x, canvas.y);
                }
            }
            
            ctx.lineTo(rightCanvas.x, rightCanvas.y);
            ctx.closePath();
            ctx.fill();
        }
    }
    
    drawWaterLine(waterLevel) {
        const ctx = this.sectionCtx;
        const intersections = [];
        
        for (let i = 0; i < this.vertices.length; i++) {
            const p1 = this.vertices[i];
            const p2 = this.vertices[(i + 1) % this.vertices.length];
            
            const inter = this.lineIntersectY(p1, p2, waterLevel);
            if (inter) {
                intersections.push(inter);
            }
        }
        
        if (intersections.length >= 2) {
            intersections.sort((a, b) => a.x - b.x);
            const left = this.toCanvas(intersections[0].x, intersections[0].y);
            const right = this.toCanvas(intersections[intersections.length - 1].x, intersections[intersections.length - 1].y);
            
            ctx.beginPath();
            ctx.strokeStyle = '#2196F3';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.moveTo(left.x, left.y);
            ctx.lineTo(right.x, right.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    
    drawRatingCurve() {
        const ctx = this.ratingCtx;
        const width = this.ratingCanvas.width;
        const height = this.ratingCanvas.height;
        const padding = 50;
        
        ctx.clearRect(0, 0, width, height);
        
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        
        let maxQ = 0;
        const maxDepth = this.getMaxDepth();
        
        if (this.schemes.length === 0 && this.vertices.length >= 3 && this.isClosed) {
            for (let i = 0; i <= 50; i++) {
                const d = (i / 50) * maxDepth;
                const result = this.calculateHydraulics(d);
                maxQ = Math.max(maxQ, result.discharge);
            }
        }
        
        this.schemes.forEach(scheme => {
            const originalVertices = this.vertices;
            const originalClosed = this.isClosed;
            const originalValid = this.isValid;
            
            this.vertices = scheme.vertices;
            this.isClosed = true;
            this.isValid = true;
            
            const schemeMaxDepth = this.getMaxDepth();
            for (let i = 0; i <= 50; i++) {
                const d = (i / 50) * schemeMaxDepth;
                const result = this.calculateHydraulics(d);
                maxQ = Math.max(maxQ, result.discharge);
            }
            
            this.vertices = originalVertices;
            this.isClosed = originalClosed;
            this.isValid = originalValid;
        });
        
        maxQ = Math.max(maxQ * 1.1, 1);
        
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        
        for (let i = 0; i <= 5; i++) {
            const y = padding + (height - 2 * padding) * (i / 5);
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
            ctx.stroke();
        }
        
        for (let i = 0; i <= 5; i++) {
            const x = padding + (width - 2 * padding) * (i / 5);
            ctx.beginPath();
            ctx.moveTo(x, padding);
            ctx.lineTo(x, height - padding);
            ctx.stroke();
        }
        
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(padding, padding);
        ctx.lineTo(padding, height - padding);
        ctx.lineTo(width - padding, height - padding);
        ctx.stroke();
        
        ctx.fillStyle = '#333';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        
        ctx.fillText('流量 Q (m³/s)', width / 2, height - 10);
        
        ctx.save();
        ctx.translate(15, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('水深 h (m)', 0, 0);
        ctx.restore();
        
        ctx.textAlign = 'right';
        for (let i = 0; i <= 5; i++) {
            const y = height - padding - (height - 2 * padding) * (i / 5);
            const val = (maxDepth * i / 5).toFixed(1);
            ctx.fillText(val, padding - 8, y + 4);
        }
        
        ctx.textAlign = 'center';
        for (let i = 0; i <= 5; i++) {
            const x = padding + (width - 2 * padding) * (i / 5);
            const val = (maxQ * i / 5).toFixed(1);
            ctx.fillText(val, x, height - padding + 20);
        }
        
        const allSchemes = [...this.schemes];
        if (this.vertices.length >= 3 && this.isClosed && this.isValid) {
            allSchemes.push({
                id: 'current',
                name: '当前断面',
                vertices: this.vertices,
                color: this.curveColors[this.schemes.length % this.curveColors.length]
            });
        }
        
        allSchemes.forEach((scheme, idx) => {
            const originalVertices = this.vertices;
            const originalClosed = this.isClosed;
            const originalValid = this.isValid;
            
            this.vertices = scheme.vertices;
            this.isClosed = true;
            this.isValid = true;
            
            const schemeMaxDepth = this.getMaxDepth();
            const color = scheme.color || this.curveColors[idx % this.curveColors.length];
            
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            
            let firstPoint = true;
            
            for (let i = 0; i <= 50; i++) {
                const d = (i / 50) * schemeMaxDepth;
                const result = this.calculateHydraulics(d);
                
                const x = padding + (width - 2 * padding) * (result.discharge / maxQ);
                const y = height - padding - (height - 2 * padding) * (d / schemeMaxDepth);
                
                if (firstPoint) {
                    ctx.moveTo(x, y);
                    firstPoint = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }
            
            ctx.stroke();
            
            if (scheme.id === 'current' || (this.currentSchemeId && scheme.id === this.currentSchemeId)) {
                const currentResult = this.calculateHydraulics(this.currentDepth);
                const x = padding + (width - 2 * padding) * (currentResult.discharge / maxQ);
                const y = height - padding - (height - 2 * padding) * (this.currentDepth / schemeMaxDepth);
                
                ctx.beginPath();
                ctx.fillStyle = '#F44336';
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            
            this.vertices = originalVertices;
            this.isClosed = originalClosed;
            this.isValid = originalValid;
        });
        
        this.updateCurveLegend(allSchemes);
    }
    
    updateCurveLegend(schemes) {
        const legendContainer = document.getElementById('curveLegend');
        legendContainer.innerHTML = '';
        
        schemes.forEach(scheme => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <span class="legend-color" style="background: ${scheme.color}"></span>
                <span>${scheme.name}</span>
            `;
            legendContainer.appendChild(item);
        });
    }
    
    showSaveModal() {
        document.getElementById('saveModal').classList.remove('hidden');
        document.getElementById('schemeName').value = '';
        document.getElementById('schemeName').focus();
    }
    
    hideSaveModal() {
        document.getElementById('saveModal').classList.add('hidden');
    }
    
    saveScheme() {
        const name = document.getElementById('schemeName').value.trim();
        if (!name) {
            alert('请输入方案名称');
            return;
        }
        
        if (!this.isClosed || !this.isValid || this.vertices.length < 3) {
            alert('请先绘制有效的断面');
            return;
        }
        
        if (this.schemes.length >= this.maxSchemes) {
            alert(`最多只能保存${this.maxSchemes}个方案`);
            return;
        }
        
        const scheme = {
            id: Date.now().toString(),
            name: name,
            vertices: JSON.parse(JSON.stringify(this.vertices)),
            n: this.n,
            S: this.S,
            color: this.curveColors[this.schemes.length % this.curveColors.length]
        };
        
        this.schemes.push(scheme);
        this.hideSaveModal();
        this.updateSchemeList();
        this.drawRatingCurve();
    }
    
    updateSchemeList() {
        const container = document.getElementById('schemeList');
        container.innerHTML = '';
        
        this.schemes.forEach(scheme => {
            const item = document.createElement('div');
            item.className = 'scheme-item' + (scheme.id === this.currentSchemeId ? ' active' : '');
            item.innerHTML = `
                <span class="color-dot" style="background: ${scheme.color}"></span>
                <span>${scheme.name}</span>
            `;
            item.addEventListener('click', () => this.loadScheme(scheme.id));
            container.appendChild(item);
        });
    }
    
    loadScheme(id) {
        const scheme = this.schemes.find(s => s.id === id);
        if (!scheme) return;
        
        this.currentSchemeId = id;
        this.vertices = JSON.parse(JSON.stringify(scheme.vertices));
        this.n = scheme.n;
        this.S = scheme.S;
        
        document.getElementById('roughnessN').value = this.n;
        document.getElementById('slopeS').value = this.S;
        
        this.isClosed = true;
        this.isValid = true;
        this.updateSliderMax();
        this.calculateAndUpdate();
        this.updateSchemeList();
    }
    
    exportJSON() {
        const data = {
            name: '当前断面',
            vertices: this.vertices,
            n: this.n,
            S: this.S,
            currentDepth: this.currentDepth,
            exportTime: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'channel-section.json';
        a.click();
        URL.revokeObjectURL(url);
    }
    
    importJSON(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                
                if (!data.vertices || !Array.isArray(data.vertices)) {
                    alert('无效的文件格式');
                    return;
                }
                
                this.vertices = data.vertices;
                this.isClosed = true;
                this.validateSection();
                
                if (!this.isValid) {
                    alert('断面轮廓不符合上开口规则');
                    this.vertices = [];
                    this.isClosed = false;
                    this.isValid = true;
                    return;
                }
                
                this.n = data.n || 0.025;
                this.S = data.S || 0.0003;
                
                document.getElementById('roughnessN').value = this.n;
                document.getElementById('slopeS').value = this.S;
                
                this.updateSliderMax();
                this.currentDepth = data.currentDepth || this.getMaxDepth() / 2;
                document.getElementById('depthSlider').value = this.currentDepth;
                document.getElementById('depthValue').textContent = this.currentDepth.toFixed(2);
                
                this.calculateAndUpdate();
                
            } catch (err) {
                alert('文件解析失败: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.calculator = new ChannelSectionCalculator();
});