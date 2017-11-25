const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      display: grid;
      grid-template-rows: 32px 1fr;
      background-color: #222;
      grid-gap: 2px;
      color: #DDD;
      font-family: monospace;
    }

    #headers {
      background-color: #333;
      align-items: center;
      display: grid;
      overflow: hidden;
      padding-left: 5px;
      padding-right: 5px;
    }

    #headers > div {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #body {
      overflow: auto;
    }

    #rows {
      display: grid;
      grid-template: "grid";
    }

    #rows > div {
      padding-left: 5px;
      padding-right: 5px;
    }

    /* changes performance profile, seems more overall gpu, but smoother */
    #rows > div > div {
      overflow: hidden;
    }
  </style>
  <div id="headers">
  </div>
  <div id="body">
    <div id="rows"></div>
  </div>
`;

const rowHeight = 32;
const bufferRows = 1;

const renderers = {
  text: class {
    constructor(data, prop) {
      this.items = data;
      this.prop = prop;
    }
    create() {
      return document.createElement("div");
    }
    render(elem) {
      // textContent is much faster than innerHTML/innerText
      elem.textContent = this.items[this.prop];
    }
  },
};


// TODO:
// X items less than display length
// X sorting
// filtering
// selection
// X renderer registration
// column resizing
// vertical resizing
// X create renderers in idle time
// pagination
// allow renderers to update data
// async renderers
export default class ZippyTable extends HTMLElement {
  static get template() {
    return template;
  }

  static get observedAttributes() {
    return ["columnHeaders", "columnProps", "columnRenderers", "preload"];
  }

  static addRenderer(name, rendererClass) {
    renderers[name] = rendererClass;
  }

  constructor() {
    super();

    this._columnHeaders = [];
    this._columnProps = [];
    this._columnRenderers = [];
    this._preload = true;

    this._items = [];
    this._itemsMeta = new WeakMap(); // tracks data associated with items (ordering, renderers)
    this._sortBys = [];

    this.attachShadow({mode: "open"}).appendChild(this.constructor.template.content.cloneNode(true));

    this.headersElem = this.shadowRoot.getElementById("headers");
    this.bodyElem = this.shadowRoot.getElementById("body");
    this.rowsElem = this.shadowRoot.getElementById("rows");

    // tracks dom elem and metadata for displayed rows
    this.rows = [];

    let requested = false;
    let lastScrollPos = 0;
    this.bodyElem.addEventListener("scroll", event => {
      if (requested) {
        return;
      }
      requested = true;

      // move rows
      requestAnimationFrame(() => {
        requested = false;
        const scrollTop = this.bodyElem.scrollTop;
        const scrolledUp = scrollTop - lastScrollPos <= 0;
        lastScrollPos = scrollTop;
        this.rows.forEach(r => {
          // row is off top
          let recycled = false;
          while (!scrolledUp && (r.offset + rowHeight < scrollTop)
            && (r.offset + this.rows.length * rowHeight + rowHeight <= this.rowsElem.clientHeight)
          ) {
            r.offset += this.rows.length * rowHeight;
            r.dataIndex += this.rows.length;
            recycled = true;
          }
          while (scrolledUp && r.offset > scrollTop + this.bodyElem.clientHeight) {
            r.offset -= this.rows.length * rowHeight;
            r.dataIndex -= this.rows.length;
            recycled = true;
          }
          // repopulate if item moved and it's at a valid index
          if (recycled) {
            r.elem.style.transform = `translateY(${r.offset}px)`;
            this.populateRow(r);
          }
        });
      });
    });
  }

  attributeChangedCallback(name, oldVal, newVal) {
    switch (name) {
      case "columnHeaders":
        if (this._columnHeaders.join(",") !== newVal) {
          this.columnHeaders = newVal;
        }
        break;
      case "columnProps":
        if (this._columnProps.join(",") !== newVal) {
          this.columnProps = newVal;
        }
        break;
      case "columnRenderers":
        if (this._columnRenderers.join(",") !== newVal) {
          this.columnRenderers = newVal;
        }
        break;
      case "preload":
        newVal = `${newVal}`.toLowerCase() == "true";
        if (this._preload !== newVal) {
          this.preload = newVal;
        }
        break;
    }
  }

  connectedCallback() {
  }

  buildRows() {
    this.rowsElem.innerHTML = "";
    this.rows = [];
    // TODO: generate rows on resize
    // find size and generate rows
    let numRows = Math.ceil(this.bodyElem.clientHeight / rowHeight) + bufferRows;
    if (numRows % 2) {
      numRows++;
    }
    // if we don't need to recycle rows, just display the number present
    let displayedRows = Math.ceil(this.bodyElem.clientHeight / rowHeight);
    if (displayedRows >= this.items.length) {
      numRows = this.items.length;
    }
    for (let i = 0; i < numRows; i++) {
      const offset = i * rowHeight;
      const row = document.createElement("div");
      row.style.backgroundColor = i % 2 ? "#333" : "#444";
      row.style.height = `${rowHeight}px`;
      row.style.transform = `translateY(${offset}px)`;
      row.style.gridArea = "grid";
      row.style.display = "grid";
      row.style.gridTemplateRows = "1fr";
      row.style.gridTemplateColumns = this._columnHeaders.map(h => `${100 / this._columnHeaders.length}%`).join(" ");
      row.style.alignItems = "center";
      row.style.willChange = "transform"; // this improves performance _a lot_
      row.style.contain = "strict"; // this improves performance _a lot_ with innerHTML
      row.innerHTML = this._columnHeaders.map(h => "<div></div>").join("");
      this.rowsElem.appendChild(row);
      const rowData = {
        offset,
        elem: row,
        dataIndex: i,
      };
      this.rows.push(rowData);
      this.populateRow(rowData, {createElement: true});
    }
  }

  // call when data has been manipulated (repopulate all rows)
  refresh() {
    this.rows.forEach(r => this.populateRow(r));
  }

  populateRow(rowData, createElement = false) {
    // skip populating rows at invalid data indexes (they should be invisible)
    if (rowData.dataIndex < 0 || rowData.dataIndex >= this.items.length) {
      return;
    }
    // initialize renderers if needed
    const data = this.items[rowData.dataIndex];
    const meta = this._itemsMeta.get(data);
    this.buildRenderers(data, {meta, elem: createElement ? rowData.elem : null});
    // run renderers
    this._columnRenderers.forEach((r, i) => {
      const renderer = meta.renderers[i];
      const elem = rowData.elem.children[i].firstChild;
      renderer.render(elem);
    });
  }

  // build renderers for item if needed
  // only pass in elem if you want the renderer to run create and add to the dom
  buildRenderers(item, {meta = null, elem = null} = {}) {
    if (!meta) {
      meta = this._itemsMeta.get(item);
    }
    if (!meta.renderers) {
      meta.renderers = this._columnRenderers.map((r, i) => {
        // build renderer
        const renderer = new renderers[r](item, this._columnProps[i]);
        // add dom elements
        if (elem) {
          elem.children[i].appendChild(renderer.create());
        }
        return renderer;
      });
    }
  }

  sort() {
    // sort according to rows
    if (this._sortBys.length) {
      this._items.sort((a, b) => {
        for (const sort of this._sortBys) {
          const prop = sort.substr(0, sort.length - 1);
          const up = sort[sort.length - 1] === "+";
          const propA = a[prop];
          const propB = b[prop];
          if (propA === propB) {
            continue;
          }
          // sort numbers
          if (typeof propA === "number") {
            const result = propA - propB;
            return up ? result : result * -1;
          }
          // sort strings (everything else)
          else {
            const result = propA > propB ? 1 : -1;
            return up ? result : result * -1;
          }
        }
        return 0;
      });
    }
    // sort according to original order
    else {
      const items = this._items.concat([]);
      const meta = items.map(i => this._itemsMeta.get(i));
      meta.sort((a, b) => a.originalOrder - b.originalOrder);
      while (this._items.length) {
        this._items.pop();
      }
      meta.forEach(m => this._items.push(m.item));
    }
    this.refresh();
  }

  get columnHeaders() {
    return this._columnHeaders;
  }

  set columnHeaders(val) {
    this._columnHeaders = val;
    this.setAttribute("columnHeaders", this._columnHeaders.join(","));
    this.headersElem.style.gridTemplateColumns = this._columnHeaders.map(h => `${100 / this._columnHeaders.length}%`).join(" ");
    this._columnHeaders.forEach(h => {
      const elem = document.createElement("div");
      elem.textContent = `${h}`;
      // update column sort on click + (ascending) - desceding, removed
      elem.addEventListener("click", () => {
        const ascIndex = this._sortBys.indexOf(`${h}+`);
        const descIndex = this._sortBys.indexOf(`${h}-`);
        if (ascIndex === -1 && descIndex === -1) {
          this._sortBys.push(`${h}+`);
          elem.textContent = `↑${h}`;
        }
        else if (ascIndex !== -1) {
          this._sortBys[ascIndex] = `${h}-`;
          elem.textContent = `↓${h}`;
        }
        else if (descIndex !== -1) {
          this._sortBys.splice(descIndex, 1);
          elem.textContent = `${h}`;
        }
        this.sort();
      });
      this.headersElem.appendChild(elem);
    });
    this.buildRows();
  }

  get columnProps() {
    return this._columnProps;
  }

  set columnProps(val) {
    this._columnProps = val;
    this.setAttribute("columnProps", this._columnProps.join(","));
  }

  get columnRenderers() {
    return this._columnRenderers;
  }

  set columnRenderers(val) {
    this._columnRenderers = val;
    this.rows.forEach(r => r.renderers = null);
    this.setAttribute("columnRenderers", this._columnRenderers.join(","));
  }

  get preload() {
    return this._preload;
  }

  set preload(val) {
    this._preload = val;
  }

  // NOTE: it isn't safe to manipulate items manually outside of ZippyTable
  // removing/replacing items will desync the table
  // updating items requires a refresh call
  get items() {
    return this._items;
  }

  // NOTE: most items are indexed by ref, so there are issues if duplicates are in items
  set items(val) {
    this._items = val;
    this._items.forEach((item, index) => this._itemsMeta.set(item, {
      item,
      renderers: null,
      originalOrder: index,
    }));
    this.rowsElem.style.minHeight = rowHeight * this._items.length;
    this.buildRows();

    // pre build renderers
    if (this.preload) {
      const buildTarget = this._items;
      let buildIndex = this.rows.length;
      const build = deadline => {
        // stop prebuilding if items has been updated
        if (buildTarget !== this._items) {
          return;
        }
        // 2 is just an arbitrary number of milliseconds so we don't overrun the deadline
        while (deadline.timeRemaining() > 2 && buildIndex < this.items.length) {
          this.buildRenderers(this.items[buildIndex]);
          buildIndex++;
        }
        if (buildIndex < this.items.length) {
          requestIdleCallback(build);
        }
      };
      if (this.rows.length) {
        requestIdleCallback(build);
      }
    }
  }
}

customElements.define("zippy-table", ZippyTable);
