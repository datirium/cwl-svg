import "../../../assets/styles/theme";
import {WorkflowFactory}   from "cwlts/models";
import {Workflow}          from "../../../";
import {SVGNodeMovePlugin} from "../node-move";

const model = WorkflowFactory.from(require(__dirname + "/app.json"));

const svgRoot = document.getElementById("svg") as any;

new Workflow({
    model: model,
    svgRoot: svgRoot,
    plugins: [
        new SVGNodeMovePlugin({
            movementSpeed: 10
        })
    ]
});

