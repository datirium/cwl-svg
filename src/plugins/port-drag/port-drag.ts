import {SVGPluginBase} from "../plugin-base";
import {Workflow}      from "../../graph/workflow";
import {GraphNode}     from "../../graph/graph-node";
import {Geometry}      from "../../utils/geometry";
import {Edge}          from "../../graph/edge";

/**
 * @FIXME: ensure that labels of newly created nodes are properly upscaled/downscaled
 * @FIXME: ensure that new edges have hover behaviour
 */
export class SVGPortDragPlugin extends SVGPluginBase {

    /** Stored on drag start to detect collision with viewport edges */
    private boundingClientRect: ClientRect;

    private portOrigins: Map<SVGGElement, SVGMatrix>;

    /** Group of edges (compound element) leading from origin port to ghost node */
    private edgeGroup: SVGGElement;

    /** Coordinates of the node from which dragged port originates, stored so we can measure the distance from it */
    private nodeCoords: { x: number; y: number };

    /** Reference to a node that marks a new input/output creation */
    private ghostNode: SVGGElement;

    /** How far away from the port you need to drag in order to create a new input/output instead of snapping */
    private snapRadius = 120;

    /** Tells if the port is on the left or on the right side of a node */
    private portType: "input" | "output";

    /** Stores a port to which a connection would snap if user stops the drag */
    private snapPort: SVGGElement;

    /** Map of CSS classes attached by this plugin */
    private classes = {

        /** Added to svgRoot as a sign that this plugin is active */
        plugin: "__plugin-port-drag",

        /** Suggests that an element that contains it will be the one to snap to */
        snap: "__port-drag-snap",

        /** Added to svgRoot while dragging is in progress */
        dragging: "__port-drag-dragging",

        /** Will be added to suggested ports and their parent nodes */
        suggestion: "__port-drag-suggestion",
    };

    /** Port from which we initiated the drag */
    private originPort: SVGGElement;

    afterRender(): void {

        this.attachPortDrag();
        this.workflow.svgRoot.classList.add(this.classes.plugin);
    }

    attachPortDrag() {
        this.workflow.domEvents.drag(
            ".port",
            this.onMove.bind(this),
            this.onMoveStart.bind(this),
            this.onMoveEnd.bind(this)
        );

    }

    onMove(dx: number, dy: number, ev: MouseEvent, portElement: SVGGElement): void {

        const ctm    = portElement.getScreenCTM();
        const coords = this.workflow.transformScreenCTMtoCanvas(ev.clientX, ev.clientY);
        const origin = this.workflow.transformScreenCTMtoCanvas(ctm.e, ctm.f);

        const nodeToMouseDistance = Geometry.distance(
            this.nodeCoords.x, this.nodeCoords.y,
            coords.x, coords.y
        );

        const closestPort = this.findClosestPort(coords.x, coords.y);
        this.updateSnapPort(closestPort.portEl, closestPort.distance);

        const scale = this.workflow.getScale();
        const moveX = origin.x + dx / scale;
        const moveY = origin.y + dy / scale;

        this.translateGhostNode(moveX, moveY);
        this.updateGhostNodeVisibility(nodeToMouseDistance, closestPort.distance);
        this.updateEdge(origin.x, origin.y, moveX, moveY);
    }

    /**
     * @FIXME: Add panning
     * @param {MouseEvent} ev
     * @param {SVGGElement} portEl
     */
    onMoveStart(ev: MouseEvent, portEl: SVGGElement): void {

        this.originPort = portEl;

        // Needed for collision detection
        this.boundingClientRect = this.workflow.svgRoot.getBoundingClientRect();

        const originNodeCTM = this.workflow.findParentNode(portEl).getCTM();
        const workflowGroup = this.workflow.workflow;

        this.portType = portEl.classList.contains("input-port") ? "input" : "output";

        this.nodeCoords = this.workflow.transformScreenCTMtoCanvas(originNodeCTM.e, originNodeCTM.f);

        this.ghostNode = this.createGhostNode(this.portType);
        workflowGroup.appendChild(this.ghostNode);

        /** @FIXME: this should come from workflow */
        this.edgeGroup = Edge.spawn();
        this.edgeGroup.classList.add("dragged");

        workflowGroup.appendChild(this.edgeGroup);

        this.workflow.svgRoot.classList.add(this.classes.dragging);


        this.portOrigins = this.getPortCandidateTransformations(portEl);

        this.highlightSuggestedPorts(portEl.getAttribute("data-connection-id"));
    }

    onMoveEnd(ev: MouseEvent): void {

        const ghostType      = this.ghostNode.getAttribute("data-type");
        const ghostIsVisible = !this.ghostNode.classList.contains("hidden");

        const shouldSnap         = this.snapPort !== undefined;
        const shouldCreateInput  = ghostIsVisible && ghostType === "input";
        const shouldCreateOutput = ghostIsVisible && ghostType === "output";
        const portID             = this.originPort.getAttribute("data-connection-id");

        if (shouldSnap) {
            this.createEdgeBetweenPorts(this.originPort, this.snapPort);
        } else if (shouldCreateInput || shouldCreateOutput) {

            const svgCoordsUnderMouse = this.workflow.transformScreenCTMtoCanvas(ev.clientX, ev.clientY);
            const {x, y}              = svgCoordsUnderMouse;
            const customProps         = {"sbg:x": x, "sbg:y": y};

            if (shouldCreateInput) {
                this.workflow.model.createInputFromPort(portID, {customProps});
            } else {
                this.workflow.model.createOutputFromPort(portID, {customProps});
            }
        }

        this.cleanMemory();
        this.cleanStyles();
    }

    private updateSnapPort(closestPort: SVGGElement, closestPortDistance: number) {

        const closestPortChanged      = closestPort !== this.snapPort;
        const closestPortIsOutOfRange = closestPortDistance > this.snapRadius;

        // We might need to remove old class for snapping if we are closer to some other port now
        if (this.snapPort && (closestPortChanged || closestPortIsOutOfRange)) {
            const node = this.workflow.findParentNode(this.snapPort);
            this.snapPort.classList.remove(this.classes.snap);
            node.classList.remove(this.classes.snap);
            delete this.snapPort;
        }

        // If closest port is further away than our snapRadius, no highlighting should be done
        if (closestPortDistance > this.snapRadius) {
            return;
        }

        const originID = this.originPort.getAttribute("data-connection-id");
        const targetID = closestPort.getAttribute("data-connection-id");

        if (this.findEdge(originID, targetID)) {
            delete this.snapPort;
            return;
        }

        this.snapPort = closestPort;

        const node             = this.workflow.findParentNode(closestPort);
        const oppositePortType = this.portType === "input" ? "output" : "input";

        closestPort.classList.add(this.classes.snap);
        node.classList.add(this.classes.snap);
        node.classList.add(`${this.classes.snap}-${oppositePortType}`);
    }

    private updateEdge(fromX: number, fromY: number, toX: number, toY: number): void {
        const subEdges = this.edgeGroup.children as HTMLCollectionOf<SVGPathElement>;

        for (let subEdge of <any>subEdges) {

            const path = Workflow.makeConnectionPath(
                fromX,
                fromY,
                toX,
                toY,
                this.portType === "input" ? "left" : "right"
            );

            subEdge.setAttribute("d", path);
        }
    }

    private updateGhostNodeVisibility(distanceToMouse: number, distanceToClosestPort) {

        const isHidden        = this.ghostNode.classList.contains("hidden");
        const shouldBeVisible = distanceToMouse > this.snapRadius && distanceToClosestPort > this.snapRadius;

        if (shouldBeVisible && isHidden) {
            this.ghostNode.classList.remove("hidden");
        } else if (!shouldBeVisible && !isHidden) {
            this.ghostNode.classList.add("hidden");
        }
    }

    private translateGhostNode(x: number, y: number) {
        this.ghostNode.transform.baseVal.getItem(0).setTranslate(x, y);
    }

    private getPortCandidateTransformations(portEl: SVGGElement): Map<SVGGElement, SVGMatrix> {
        const nodeEl           = this.workflow.findParentNode(portEl);
        const nodeConnectionID = nodeEl.getAttribute("data-connection-id");

        const otherPortType = this.portType === "input" ? "output" : "input";
        const portQuery     = `.node:not([data-connection-id="${nodeConnectionID}"]) .port.${otherPortType}-port`;

        const candidates = this.workflow.workflow.querySelectorAll(portQuery) as NodeListOf<SVGGElement>;
        const matrices   = new Map<SVGGElement, SVGMatrix>();

        for (let port of candidates) {
            matrices.set(port, Geometry.getTransformToElement(port, this.workflow.workflow));
        }

        return matrices;
    }

    /**
     * Highlights ports that are model says are suggested.
     * Also marks their parent nodes as highlighted.
     *
     * @param {string} targetConnectionID ConnectionID of the origin port
     */
    private highlightSuggestedPorts(targetConnectionID: string): void {

        // Find all ports that we can validly connect to
        // Note that we can connect to any port, but some of them are suggested based on hypothetical validity.
        const portModels = this.workflow.model.gatherValidConnectionPoints(targetConnectionID);

        for (let i = 0; i < portModels.length; i++) {

            const portModel = portModels[i];

            if (!portModel.isVisible) continue;

            // Find port element by this connectionID and it's parent node element
            const portQuery   = `.port[data-connection-id="${portModel.connectionId}"]`;
            const portElement = this.workflow.workflow.querySelector(portQuery);
            const parentNode  = this.workflow.findParentNode(portElement);

            // Add highlighting classes to port and it's parent node
            parentNode.classList.add(this.classes.suggestion);
            portElement.classList.add(this.classes.suggestion);
        }
    }

    /**
     * @FIXME: GraphNode.radius should somehow come through Workflow,
     * @returns {SVGGElement}
     */
    private createGhostNode(type: "input" | "output"): SVGGElement {
        const namespace = "http://www.w3.org/2000/svg";
        const node      = document.createElementNS(namespace, "g");

        node.setAttribute("transform", "matrix(1,0,0,1,0,0)");
        node.setAttribute("data-type", type);
        node.classList.add("ghost");
        node.classList.add("node");
        node.innerHTML = `<circle class="ghost-circle" cx="0" cy="0" r="${GraphNode.radius / 1.5}"></circle>`;

        return node;
    }

    /**
     * Finds a port closest to given SVG coordinates.
     */
    private findClosestPort(x: number, y: number): { portEl: SVGGElement | undefined, distance: number } {
        let closestPort     = undefined;
        let closestDistance = Infinity;

        this.portOrigins.forEach((matrix, port) => {

            const distance = Geometry.distance(x, y, matrix.e, matrix.f);

            if (distance < closestDistance) {
                closestPort     = port;
                closestDistance = distance;
            }
        });


        return {
            portEl: closestPort,
            distance: closestDistance
        };
    }

    /**
     * Removes all dom elements and objects cached in-memory during dragging that are no longer needed.
     */
    private cleanMemory() {
        this.edgeGroup.remove();
        this.ghostNode.remove();

        delete this.nodeCoords;
        delete this.originPort;
        delete this.portOrigins;
        delete this.boundingClientRect;
    }

    /**
     * Removes all css classes attached by this plugin
     */
    private cleanStyles(): void {
        this.workflow.svgRoot.classList.remove(this.classes.dragging);

        for (let cls in this.classes) {
            const query = this.workflow.svgRoot.querySelectorAll("." + this.classes[cls]);

            for (let el of query) {
                el.classList.remove(this.classes[cls]);
            }
        }
    }


    /**
     * Creates an edge (connection) between two elements determined by their connection IDs
     * This edge is created on the model, and not rendered directly on graph, as main workflow
     * is supposed to catch the creation event and draw it.
     */
    private createEdgeBetweenPorts(source: SVGGElement, destination: SVGGElement): void {

        // Find the connection ids of origin port and the highlighted port
        let sourceID      = source.getAttribute("data-connection-id");
        let destinationID = destination.getAttribute("data-connection-id");

        // Swap their places in case you dragged out from input to output, since they have to be ordered output->input
        if (sourceID.startsWith("in")) {
            const tmp     = sourceID;
            sourceID      = destinationID;
            destinationID = tmp;
        }

        this.workflow.model.connect(sourceID, destinationID);
    }

    private findEdge(sourceID: string, destinationID: string): SVGGElement | undefined {
        const ltrQuery = `[data-source-connection="${sourceID}"][data-destination-connection="${destinationID}"]`;
        const rtlQuery = `[data-source-connection="${destinationID}"][data-destination-connection="${sourceID}"]`;
        return this.workflow.workflow.querySelector(`${ltrQuery},${rtlQuery}`) as SVGGElement;
    }
}