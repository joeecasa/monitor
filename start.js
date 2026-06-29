const { spawn } = require("child_process");

function run(script) {
  console.log(`[start] Iniciando ${script}...`);
  const p = spawn("node", [script], { stdio: "inherit" });
  p.on("exit", (code) => {
    console.log(`[start] ${script} terminó (código ${code}), reiniciando en 10s...`);
    setTimeout(() => run(script), 10000);
  });
}

run("monitor.js");
run("monitor-tracker.js");
