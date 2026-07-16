(() => {
  "use strict";

  const POTREE_URL = "https://recorridos.dronemapping.mx/max-huasca-v2/";
  const SUPPORT_NUMBER = "527757602869";

  const viewConfig = {
    compare: {
      label: "Comparativa",
      caption: "Compara la apariencia real del terreno con la distribución de elevaciones procesada.",
      base: "assets/view-rgb.webp",
      baseAlt: "Ortomosaico RGB del proyecto",
      comparison: "assets/view-elevation.webp",
      comparisonAlt: "Vista de elevación del proyecto"
    },
    rgb: {
      label: "RGB",
      caption: "Ortomosaico: una lectura continua de la apariencia visible del área trabajada.",
      base: "assets/view-rgb.webp",
      baseAlt: "Ortomosaico RGB del proyecto Max Huasca"
    },
    elevation: {
      label: "Elevación",
      caption: "Paleta de elevación aplicada a la nube para distinguir cambios de relieve dentro del área visible.",
      base: "assets/view-elevation.webp",
      baseAlt: "Nube de puntos coloreada por elevación"
    },
    mde: {
      label: "MDE",
      caption: "Modelo digital de elevación preparado para interpretar la forma general de la superficie.",
      base: "assets/view-mde.webp",
      baseAlt: "Modelo digital de elevación del proyecto"
    },
    map: {
      label: "Mapa",
      caption: "Encuadre cartográfico de consulta para reconocer el contexto general del proyecto, sin publicar coordenadas exactas.",
      base: "assets/view-map.webp",
      baseAlt: "Mapa general del proyecto sin coordenadas sensibles"
    }
  };

  const statusFilters = [
    ["all", "Todos"],
    ["delivered", "Entregados"],
    ["available", "Disponibles"],
    ["review", "En revisión"],
    ["request", "Por solicitud"]
  ];

  const fallbackPlanPages = Array.from({ length: 6 }, (_, index) => ({
    number: String(index + 1).padStart(2, "0"),
    title: `Página ${index + 1} del juego de planos`,
    src: `assets/plan/page-${String(index + 1).padStart(2, "0")}.webp`
  }));

  const qs = (selector, scope = document) => scope.querySelector(selector);
  const qsa = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (typeof text === "string") element.textContent = text;
    return element;
  }

  function getSafeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;

    try {
      const parsed = new URL(rawUrl, window.location.href);
      if (!["http:", "https:"].includes(parsed.protocol)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function initialiseViewLab() {
    const tabs = qsa(".view-tab");
    const panel = qs("#view-panel");
    const stage = qs("#viewStage");
    const baseImage = qs("#viewBase");
    const comparisonImage = qs("#viewCompare");
    const overlay = qs("#viewOverlay");
    const divider = qs("#wipeDivider");
    const wipeControl = qs("#wipeControl");
    const wipeRange = qs("#wipeRange");
    const wipeValue = qs("#wipeValue");
    const leftLabel = qs("#leftLayerLabel");
    const rightLabel = qs("#rightLayerLabel");
    const caption = qs("#viewCaption");
    const error = qs("#viewError");

    if (!tabs.length || !panel || !stage || !baseImage) return;

    const handleMediaLoad = () => {
      error.hidden = true;
    };
    const handleMediaError = () => {
      error.hidden = false;
    };

    baseImage.addEventListener("load", handleMediaLoad);
    baseImage.addEventListener("error", handleMediaError);
    comparisonImage?.addEventListener("load", handleMediaLoad);
    comparisonImage?.addEventListener("error", handleMediaError);

    function selectView(viewName, selectedTab) {
      const config = viewConfig[viewName];
      if (!config) return;

      tabs.forEach((tab) => {
        const active = tab === selectedTab;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      });

      panel.setAttribute("aria-labelledby", selectedTab.id);
      error.hidden = true;
      baseImage.src = config.base;
      baseImage.alt = config.baseAlt;
      caption.textContent = config.caption;

      const isComparison = viewName === "compare";
      if (comparisonImage && config.comparison) {
        comparisonImage.src = config.comparison;
        comparisonImage.alt = config.comparisonAlt;
      }

      overlay.hidden = !isComparison;
      divider.hidden = !isComparison;
      wipeControl.hidden = !isComparison;
      leftLabel.hidden = !isComparison;
      rightLabel.hidden = !isComparison;

      if (isComparison) {
        leftLabel.textContent = "Elevación";
        rightLabel.textContent = "RGB";
      }
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectView(tab.dataset.view, tab));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;

        event.preventDefault();
        const nextTab = tabs[nextIndex];
        nextTab.focus();
        selectView(nextTab.dataset.view, nextTab);
      });
    });

    function updateWipe(value) {
      const numericValue = Number(value);
      stage.style.setProperty("--wipe", `${numericValue}%`);
      wipeValue.value = `${numericValue}% elevación`;
      wipeRange.setAttribute("aria-valuetext", `${numericValue}% elevación, ${100 - numericValue}% RGB`);
    }

    wipeRange?.addEventListener("input", (event) => updateWipe(event.target.value));
    updateWipe(wipeRange?.value || 52);
    selectView("compare", tabs[0]);
  }

  function initialisePotree() {
    const shell = qs("#potreeShell");
    const poster = qs("#potreePoster");
    const frame = qs("#potreeFrame");
    const activateButton = qs("#activatePotree");
    const fullscreenButton = qs("#fullscreenPotree");
    const status = qs("#potreeStatus");
    let activated = false;
    let slowLoadTimer = null;

    if (!shell || !poster || !frame || !activateButton || !fullscreenButton || !status) return;

    activateButton.addEventListener("click", () => {
      if (activated) return;
      activated = true;
      activateButton.disabled = true;
      status.textContent = "Cargando el visor 3D…";

      const iframe = document.createElement("iframe");
      iframe.src = frame.dataset.src || POTREE_URL;
      iframe.title = "Visor 3D de la nube de puntos del proyecto Max Huasca";
      iframe.allow = "fullscreen";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";

      iframe.addEventListener("load", () => {
        window.clearTimeout(slowLoadTimer);
        status.textContent = "Visor 3D activo.";
        fullscreenButton.disabled = false;
      }, { once: true });

      slowLoadTimer = window.setTimeout(() => {
        status.textContent = "La carga está tardando más de lo habitual. Puedes abrir el visor en otra pestaña.";
      }, 15000);

      frame.replaceChildren(iframe);
      poster.hidden = true;
      frame.hidden = false;
    });

    fullscreenButton.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (shell.requestFullscreen) {
          await shell.requestFullscreen();
        } else {
          window.open(POTREE_URL, "_blank", "noopener,noreferrer");
        }
      } catch {
        status.textContent = "No fue posible activar pantalla completa. Usa “Abrir en otra pestaña”.";
      }
    });

    document.addEventListener("fullscreenchange", () => {
      fullscreenButton.textContent = document.fullscreenElement ? "Salir de pantalla completa" : "Pantalla completa";
    });
  }

  function initialiseDialog() {
    const dialog = qs("#previewDialog");
    const closeButton = qs("#closePreview");

    if (!dialog || !closeButton) return;

    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialog.close();
    });
  }

  function openPreview(title, preview) {
    const dialog = qs("#previewDialog");
    const titleElement = qs("#previewTitle");
    const body = qs("#previewBody");
    if (!dialog || !titleElement || !body || !preview) return;

    titleElement.textContent = title;
    body.replaceChildren();

    const safeSource = getSafeUrl(preview.src);
    if (!safeSource) {
      renderPreviewFallback(body, "La dirección de esta vista previa no es válida.");
    } else if (preview.kind === "image") {
      const wrapper = createElement("div", "preview-dialog__image");
      const image = document.createElement("img");
      image.src = safeSource;
      image.alt = title;
      image.addEventListener("error", () => {
        body.replaceChildren();
        renderPreviewFallback(body, "La imagen aún no está disponible en este portal.");
      }, { once: true });
      wrapper.append(image);
      body.append(wrapper);
    } else if (preview.kind === "pdf") {
      const object = document.createElement("object");
      object.data = safeSource;
      object.type = "application/pdf";
      object.setAttribute("aria-label", `Vista previa de ${title}`);

      const fallback = createElement("div", "preview-fallback");
      fallback.append(createElement("p", "", "Tu navegador no puede mostrar este PDF dentro del portal."));
      const link = createElement("a", "button button--outline-dark", "Abrir PDF en otra pestaña");
      link.href = safeSource;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      fallback.append(link);
      object.append(fallback);
      body.append(object);
    } else {
      renderPreviewFallback(body, "Este formato no tiene una vista previa compatible con el navegador.", safeSource);
    }

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function renderPreviewFallback(container, message, href = null) {
    const fallback = createElement("div", "preview-fallback");
    fallback.append(createElement("p", "", message));
    if (href) {
      const link = createElement("a", "button button--outline-dark", "Abrir archivo");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      fallback.append(link);
    }
    container.append(fallback);
  }

  function createActionLink(label, href, isDownload = false) {
    const link = createElement("a", "button button--outline-dark", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (isDownload) link.setAttribute("download", "");
    return link;
  }

  function createDeliverableCard(item, statusLabels) {
    const card = createElement("article", "deliverable-card");
    card.dataset.status = item.status;

    const head = createElement("div", "deliverable-card__head");
    const iconBox = createElement("div", "deliverable-card__icon");
    const iconUrl = getSafeUrl(item.icon);
    if (iconUrl) {
      const icon = document.createElement("img");
      icon.src = iconUrl;
      icon.alt = "";
      icon.width = 26;
      icon.height = 26;
      icon.setAttribute("aria-hidden", "true");
      iconBox.append(icon);
    }

    const content = createElement("div", "deliverable-card__content");
    const meta = createElement("div", "deliverable-card__meta");
    meta.append(createElement("span", "format-tag", item.format || "Archivo"));
    meta.append(createElement("span", "status-badge", statusLabels[item.status] || item.status));
    content.append(meta);
    content.append(createElement("h3", "", item.title));
    content.append(createElement("p", "deliverable-card__summary", item.summary));
    head.append(iconBox, content);
    card.append(head);

    const actions = createElement("div", "deliverable-card__actions");
    const safeHref = getSafeUrl(item.href);

    if (item.preview?.src) {
      const previewButton = createElement("button", "button button--outline-dark", "Vista previa");
      previewButton.type = "button";
      previewButton.addEventListener("click", () => openPreview(item.title, item.preview));
      actions.append(previewButton);
    }

    if (safeHref) {
      const wantsDownload = /descargar/i.test(item.actionLabel || "");
      actions.append(createActionLink(item.actionLabel || "Abrir archivo", safeHref, wantsDownload));
    } else if (item.status === "request") {
      const message = item.requestMessage || `Hola, quisiera solicitar ${item.title} del proyecto Max Huasca.`;
      const requestUrl = `https://wa.me/${SUPPORT_NUMBER}?text=${encodeURIComponent(message)}`;
      actions.append(createActionLink("Solicitar archivo", requestUrl));
    }

    if (actions.children.length) card.append(actions);
    return card;
  }

  function renderDeliverables(items, labels, filter = "all") {
    const grid = qs("#deliverablesGrid");
    const empty = qs("#deliverablesEmpty");
    if (!grid || !empty) return;

    const visibleItems = filter === "all" ? items : items.filter((item) => item.status === filter);
    grid.replaceChildren();
    grid.setAttribute("aria-busy", "false");
    empty.hidden = visibleItems.length > 0;

    visibleItems.forEach((item) => grid.append(createDeliverableCard(item, labels)));
  }

  function renderFilters(items, labels) {
    const filterBar = qs("#deliverableFilters");
    if (!filterBar) return;

    filterBar.replaceChildren();
    statusFilters.forEach(([value, label], index) => {
      const count = value === "all" ? items.length : items.filter((item) => item.status === value).length;
      if (value !== "all" && count === 0) return;

      const button = createElement("button", `filter-button${index === 0 ? " is-active" : ""}`, `${label} · ${count}`);
      button.type = "button";
      button.dataset.filter = value;
      button.setAttribute("aria-pressed", String(index === 0));
      button.addEventListener("click", () => {
        qsa(".filter-button", filterBar).forEach((candidate) => {
          const active = candidate === button;
          candidate.classList.toggle("is-active", active);
          candidate.setAttribute("aria-pressed", String(active));
        });
        renderDeliverables(items, labels, value);
      });
      filterBar.append(button);
    });
    filterBar.hidden = false;
  }

  function renderPlanGallery(pages) {
    const gallery = qs("#planGallery");
    if (!gallery) return;
    gallery.replaceChildren();

    pages.forEach((page) => {
      const button = createElement("button", "plan-card");
      button.type = "button";
      button.setAttribute("aria-label", `Ampliar hoja ${page.number}: ${page.title}`);

      const imageWrap = createElement("div", "plan-card__image");
      const image = document.createElement("img");
      image.src = page.src;
      image.alt = `Vista previa de la hoja ${page.number}: ${page.title}`;
      image.loading = "lazy";
      image.width = 640;
      image.height = 480;
      image.addEventListener("error", () => {
        image.remove();
        imageWrap.classList.add("is-missing");
        imageWrap.append(createElement("p", "", "Vista previa pendiente"));
      }, { once: true });
      imageWrap.append(image);

      const text = createElement("div", "plan-card__text");
      text.append(createElement("span", "plan-card__number", page.number));
      text.append(createElement("span", "plan-card__title", page.title));
      button.append(imageWrap, text);
      button.addEventListener("click", () => openPreview(`Hoja ${page.number} · ${page.title}`, { kind: "image", src: page.src }));
      gallery.append(button);
    });
  }

  async function loadManifest() {
    const errorState = qs("#deliverablesError");
    const grid = qs("#deliverablesGrid");

    try {
      const response = await fetch("manifest.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
      const manifest = await response.json();
      if (!Array.isArray(manifest.deliverables)) throw new Error("Manifest incompleto");

      const labels = manifest.statusLabels || {};
      renderFilters(manifest.deliverables, labels);
      renderDeliverables(manifest.deliverables, labels);
      renderPlanGallery(Array.isArray(manifest.planPages) ? manifest.planPages : fallbackPlanPages);
    } catch (error) {
      console.warn("No se pudo cargar el manifiesto del portal:", error);
      if (grid) {
        grid.replaceChildren();
        grid.setAttribute("aria-busy", "false");
      }
      if (errorState) errorState.hidden = false;
      renderPlanGallery(fallbackPlanPages);
    }
  }

  function initialise() {
    const year = qs("#currentYear");
    if (year) year.textContent = String(new Date().getFullYear());

    initialiseViewLab();
    initialisePotree();
    initialiseDialog();
    loadManifest();
  }

  initialise();
})();
