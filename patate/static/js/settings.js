/* Settings : création de packs, uploads, import de dossier (toutes les requêtes portent X-Patate). */
(function () {
  "use strict";

  const msg = document.getElementById("msg");
  const say = (text, isError = false) => {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle("error", isError);
  };

  async function api(method, url, body) {
    const opts = { method, headers: { "X-Patate": "1" }, credentials: "same-origin" };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (_) { /* réponse vide */ }
    if (res.status === 401) {
      location.href = "/settings/login?next=" + encodeURIComponent(location.pathname);
      throw new Error("Mot de passe requis.");
    }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  async function run(label, fn) {
    say(label);
    try {
      await fn();
    } catch (err) {
      say(err.message, true);
    }
  }

  // ---- liste des packs -----------------------------------------------------
  const create = document.getElementById("create-pack");
  if (create) {
    create.addEventListener("submit", (evt) => {
      evt.preventDefault();
      run("Création…", async () => {
        const pack = await api("POST", "/api/packs", {
          name: create.elements.name.value,
          private: create.elements.private.checked,
        });
        location.href = `/settings/${pack.id}`;
      });
    });
  }

  // ---- édition d'un pack ---------------------------------------------------
  const editor = document.getElementById("pack-editor");
  if (!editor) return;
  const packId = editor.dataset.pack;
  const base = `/api/packs/${encodeURIComponent(packId)}`;
  const reload = () => location.reload();

  let audio = null;
  editor.querySelectorAll(".play").forEach((btn) => btn.addEventListener("click", () => {
    if (audio) audio.pause();
    audio = new Audio(btn.dataset.src);
    audio.play().catch(() => say("Lecture impossible.", true));
  }));

  if (editor.dataset.readonly === "true") return;

  const meta = document.getElementById("pack-meta");
  meta.addEventListener("submit", (evt) => {
    evt.preventDefault();
    run("Enregistrement…", async () => {
      await api("PATCH", base, {
        name: meta.elements.name.value,
        crop_circle: meta.elements.crop_circle.checked,
        private: meta.elements.private.checked,
      });
      reload();
    });
  });

  document.getElementById("save-labels").addEventListener("click", () => {
    const labels = [...editor.querySelectorAll(".label-input")].map((i) => i.value);
    run("Enregistrement…", async () => { await api("PATCH", base, { labels }); say("Noms enregistrés."); });
  });

  document.getElementById("delete-pack").addEventListener("click", () => {
    if (!confirm("Supprimer ce pack et tous ses fichiers ?")) return;
    run("Suppression…", async () => { await api("DELETE", base); location.href = "/settings"; });
  });

  editor.querySelectorAll(".slot").forEach((slot) => {
    const level = slot.dataset.level;
    slot.querySelectorAll("input.up").forEach((input) => input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      run("Envoi…", async () => { await api("POST", `${base}/slots/${level}/${input.dataset.kind}`, form); reload(); });
    }));
    slot.querySelectorAll(".clear").forEach((btn) => btn.addEventListener("click", () => {
      run("Suppression…", async () => { await api("DELETE", `${base}/slots/${level}/${btn.dataset.kind}`); reload(); });
    }));
  });

  const MEDIA = /\.(png|jpe?g|gif|webp|bmp|mp3|wav|ogg)$/i;
  for (const id of ["import-dir", "import-files"]) {
    const input = document.getElementById(id);
    input.addEventListener("change", () => {
      const files = [...input.files].filter((f) => MEDIA.test(f.name) && !f.name.startsWith("."));
      if (!files.length) return say("Aucune image ni aucun son dans cette sélection.", true);
      // 1) le serveur répartit les noms sur les niveaux ; 2) on n'envoie que les fichiers
      //    retenus, un par requête (un dossier de photos dépasserait la limite d'un seul envoi)
      run(`Analyse de ${files.length} fichier(s)…`, async () => {
        const plan = await api("POST", `${base}/import/plan`, { names: files.map((f) => f.name) });
        const jobs = [];
        for (const kind of ["image", "sound"]) {
          for (const [level, index] of Object.entries(plan[kind])) jobs.push([kind, level, files[index]]);
        }
        const done = { image: 0, sound: 0 };
        const failed = [];
        for (const [i, [kind, level, file]] of jobs.entries()) {
          say(`Envoi ${i + 1}/${jobs.length} : ${file.name}`);
          const form = new FormData();
          form.append("file", file, file.name);
          try {
            await api("POST", `${base}/slots/${level}/${kind}`, form);
            done[kind]++;
          } catch (err) {
            failed.push(`${file.name} (${err.message})`);
          }
        }
        let text = `${done.image} image(s) et ${done.sound} son(s) importés.`;
        if (plan.ignored.length) text += ` Non utilisés : ${plan.ignored.join(", ")}.`;
        if (failed.length) text += ` Échecs : ${failed.join(", ")}.`;
        sessionStorage.setItem("patate.msg", text);
        reload();
      });
    });
  }

  const pending = sessionStorage.getItem("patate.msg");
  if (pending) { say(pending); sessionStorage.removeItem("patate.msg"); }
})();
