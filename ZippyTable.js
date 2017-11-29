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
      --scrollbar-width: 0px;
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

    /* the rows  */
    #rows > div {
      padding-left: 5px;
      padding-right: 5px;
    }

    /* the cell rows */
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

const minColumnSize = 45;
const rowHeight = 32;
const bufferRows = 1;

const renderers = {
  text: class {
    constructor(data, prop) {
      this.data = data;
      this.prop = prop;
    }
    create() {
      return document.createElement("div");
    }
    render(elem) {
      // textContent is much faster than innerHTML/innerText
      elem.textContent = this.data[this.prop];
    }
  },
};

// TODO:
// X fix headers offset (scrollbar is taking up space in body)
// X BUG: gap appears in columns when scrolling on osx with retina and magic mouse
// X intelligent initial column sizes
// filtering
// selection
// sticky columns
// X column resizing
// dynamic columns (being able to dynamically add/remove columns)
//   Make sure selection, scroll position etc are preserved
// X items less than display length
// X sorting
// X renderer registration
// X vertical resizing
// X create renderers in idle time
// pagination
// X allow renderers to update data
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
    this._columnSizes = {};

    this.attachShadow({mode: "open"}).appendChild(this.constructor.template.content.cloneNode(true));

    this.headersElem = this.shadowRoot.getElementById("headers");

    this.bodyElem = this.shadowRoot.getElementById("body");
    let height = this.bodyElem.clientHeight;
    const resize = () => {
      // TODO: replace this with ResizeObserver when available
      // if resized
      if (this.bodyElem.clientHeight !== height) {
        height = this.bodyElem.clientHeight;
        this.moveRows(false);
        while (this.calcRowsNeeded() > this.rows.length) {
          const maxIndex = this.rows.reduce((a, b) => Math.max(a, b.dataIndex), 0);
          this.buildRow(maxIndex + 1);
        }
      }
      requestAnimationFrame(resize);
    };
    requestAnimationFrame(resize);

    this.rowsElem = this.shadowRoot.getElementById("rows");

    // tracks dom elem and metadata for displayed rows
    this.rows = [];

    let requested = false;
    let lastScrollPos = 0;
    const scroll = event => {
      if (requested) {
        return;
      }
      requested = true;

      // move rows
      requestAnimationFrame(() => {
        requested = false;
        const scrollTop = this.bodyElem.scrollTop;
        const scrolledUp = event.deltaY ? event.deltaY < 0 : scrollTop - lastScrollPos < 0;
        const scrollTopMod = event.deltaY ? event.deltaY : 0;
        lastScrollPos = scrollTop;
        this.moveRows(scrolledUp, {scrollTopMod});
      });
    };
    this.bodyElem.addEventListener("wheel", scroll);
    this.bodyElem.addEventListener("scroll", scroll);
  }

  moveRows(up, {scrollTopMod = 0} = {}) {
    // add mouse delta to scrollTop
    let scrollTop = this.bodyElem.scrollTop + scrollTopMod;
    // constrain scrollTop to bounds
    if (scrollTop < 0) {
      scrollTop = 0;
    }
    else if (scrollTop > this._items.length * rowHeight - this.bodyElem.clientHeight) {
      scrollTop = this._items.length * rowHeight - this.bodyElem.clientHeight;
    }

    this.rows.forEach(r => {
      // row is off top
      let recycled = false;
      const dataIndex = r.dataIndex;
      while (!up && (r.offset + rowHeight < scrollTop)
        && (r.offset + this.rows.length * rowHeight + rowHeight <= this.rowsElem.clientHeight)
      ) {
        r.offset += this.rows.length * rowHeight;
        r.dataIndex += this.rows.length;
        recycled = true;
      }
      while (up && r.offset > scrollTop + this.bodyElem.clientHeight) {
        r.offset -= this.rows.length * rowHeight;
        r.dataIndex -= this.rows.length;
        recycled = true;
      }
      // recycle/repopulate if item moved and it's at a valid index
      if (recycled) {
        if (dataIndex >= 0 && dataIndex < this._items.length) {
          const meta = this._itemsMeta.get(this._items[dataIndex]);
          meta.renderers.forEach((renderer, i) => {
            if (renderer.recycle) {
              const elem = r.elem.children[i].firstChild;
              renderer.recycle(elem);
            }
          });
        }

        r.elem.style.transform = `translateY(${r.offset}px)`;
        this.populateRow(r);
      }
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

  calcRowsNeeded() {
    // find size and generate rows
    let numRows = Math.ceil(this.bodyElem.clientHeight / rowHeight) + bufferRows;
    if (numRows % 2) {
      numRows++;
    }
    // if we don't need to recycle rows, just display the number present
    let displayedRows = Math.ceil(this.bodyElem.clientHeight / rowHeight);
    if (displayedRows >= this.items.length || numRows >= this.items.length) {
      numRows = this.items.length;
    }

    return numRows;
  }

  buildRows() {
    this.rowsElem.innerHTML = "";
    this.rows = [];
    const numRows = this.calcRowsNeeded();
    for (let i = 0; i < numRows; i++) {
      this.buildRow(i);
    }
    this.shadowRoot.host.style.setProperty("--scrollbar-width", `${this.headersElem.clientWidth - this.rowsElem.clientWidth}px`);
  }

  buildRow(index) {
    const offset = index * rowHeight;
    const row = document.createElement("div");
    row.style.backgroundColor = index % 2 ? "#333" : "#444";
    row.style.height = `${rowHeight}px`;
    row.style.transform = `translateY(${offset}px)`;
    row.style.gridArea = "grid";
    row.style.display = "grid";
    row.style.gridTemplateRows = "1fr";
    row.style.gridTemplateColumns = this._columnHeaders.map((h, i) => `var(--column-width-${i})`).join(" ");
    row.style.alignItems = "center";
    row.style.willChange = "transform"; // this improves performance _a lot_
    row.style.contain = "strict"; // this improves performance _a lot_ with innerHTML
    row.innerHTML = this._columnHeaders.map(h => "<div></div>").join("");
    this.rowsElem.appendChild(row);
    const rowData = {
      offset,
      elem: row,
      dataIndex: index,
    };
    this.rows.push(rowData);
    this.populateRow(rowData, {createElement: true});
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
    meta.renderers.forEach((r, i) => {
      const elem = rowData.elem.children[i].firstChild;
      r.render(elem);
    });
  }

  // build renderers for item if needed
  // only pass in elem if you want the renderer to run create and add to the dom
  buildRenderers(item, {meta = null, elem = null} = {}) {
    if (!meta) {
      meta = this._itemsMeta.get(item);
    }
    // if renderers need to be built
    if (!meta.renderers) {
      meta.renderers = this._columnRenderers.map((r, i) => {
        // build renderer
        const renderer = new renderers[r](item, this._columnProps[i], () => this.itemUpdated(item));
        return renderer;
      });
    }
    // build dom elements
    if (elem) {
      meta.renderers.forEach((r, i) => {
        elem.children[i].appendChild(r.create());
      });
    }
  }

  itemUpdated(item) {
    this.dispatchEvent(new CustomEvent("itemUpdated", {detail: {item}}));
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

  setColumnSize(column, size) {
    // minimum column size (px)
    if (size < minColumnSize) {
      size = minColumnSize;
    }

    for (let i = 0; i < this._columnHeaders.length; i++) {
      const header = this._columnHeaders[i];
      if (!this._columnSizes[header]) {
        const elem = this.headersElem.children[i];
        this._columnSizes[header] = {size: elem.clientWidth, type: "preferred"};
      }
      if (header === column) {
        this._columnSizes[header].type = "explicit";
        this._columnSizes[header].size = size;
        break;
      }
    }

    this.calcColumnSizes();
  }

  calcColumnSizes() {
    const numExplicitSizes = this._columnHeaders.filter(h => this._columnSizes.hasOwnProperty(h)).length;
    // add up all explicit widths
    const explicitSizes = this._columnHeaders
      .map(h => this._columnSizes[h] ? this._columnSizes[h].size : 0)
      .reduce((a, b) => a + b, 0);
    // -10 to compensate for padding on headers/rows
    // TODO: make padding size into var
    const availableSize = this.headersElem.clientWidth - 10;
    this._columnHeaders.forEach((h, i) => {
      // set explicit widths in pixels
      if (this._columnSizes[h] && this._columnSizes[h].type === "explicit") {
        this.shadowRoot.host.style.setProperty(`--column-width-${i}`, `${this._columnSizes[h].size}px`);
      }
      // set preferred widths in percentages calculated from pixels
      else if (this._columnSizes[h] && this._columnSizes[h].type === "preferred") {
        this.shadowRoot.host.style.setProperty(`--column-width-${i}`, `${this._columnSizes[h].size / availableSize * 100}%`);
      }
      // share available space by default
      else {
        const availableToMe = availableSize - explicitSizes;
        const myShare = availableToMe / (this._columnHeaders.length - numExplicitSizes);
        this.shadowRoot.host.style.setProperty(`--column-width-${i}`, `${myShare / availableSize * 100}%`);
      }
    });
  }

  get columnHeaders() {
    return this._columnHeaders;
  }

  set columnHeaders(val) {
    this._columnHeaders = val;
    this.setAttribute("columnHeaders", this._columnHeaders.join(","));
    this.headersElem.innerHTML = "";
    this.headersElem.style.gridTemplateColumns = this._columnHeaders.map((h, i) => `calc(var(--column-width-${i}) - var(--scrollbar-width))`).join(" ");
    this._columnHeaders.forEach((h, i) => {
      const elem = document.createElement("div");
      elem.style.display = "flex";
      elem.style.justifyContent = "space-between";
      elem.style.alignItems = "center";

      let resizing = false;

      // add text (with sorting on click)
      const text = document.createElement("div");
      text.textContent = `${h}`;
      elem.style.cursor = "n-resize";
      // update column sort on click + (ascending) - desceding, removed
      elem.addEventListener("click", () => {
        if (resizing) {
          return;
        }

        const prop = this._columnProps[i];
        const ascIndex = this._sortBys.indexOf(`${prop}+`);
        const descIndex = this._sortBys.indexOf(`${prop}-`);
        if (ascIndex === -1 && descIndex === -1) {
          this._sortBys.push(`${prop}+`);
          text.textContent = `↑${h}`;
          text.style.cursor = "s-resize";
        }
        else if (ascIndex !== -1) {
          this._sortBys[ascIndex] = `${prop}-`;
          text.textContent = `↓${h}`;
          text.style.cursor = "auto";
        }
        else if (descIndex !== -1) {
          this._sortBys.splice(descIndex, 1);
          text.textContent = `${h}`;
          text.style.cursor = "n-resize";
        }
        this.sort();
      });
      elem.appendChild(text);

      // add resize handle
      if (i !== this._columnHeaders.length - 1) {
        const resizeHandle = document.createElement("div");
        resizeHandle.style.cursor = "col-resize";
        resizeHandle.style.width = "4px";
        resizeHandle.style.backgroundColor = "#222";
        resizeHandle.style.height = "100%";
        resizeHandle.style.justifySelf = "flex-end";
        resizeHandle.style.marginRight = "5px";
        const onResize = event => {
          event.preventDefault();
          event.stopPropagation();
          resizing = true;
          let startX = event.pageX;
          let startWidth = elem.clientWidth;

          // follow mouse
          const onMove = event => {
            // console.log(event);
            this.setColumnSize(h, startWidth + event.pageX - startX);
          };
          const onUp = event => {
            setTimeout(() => resizing = false, 0);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          }
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        };
        resizeHandle.addEventListener("mousedown", onResize);
        elem.appendChild(resizeHandle);
      }

      this.headersElem.appendChild(elem);
    });
    this.buildRows();
    this.calcColumnSizes();
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
    this.rowsElem.style.minHeight = `${rowHeight * this._items.length}px`;
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

  // sizer is an item used to calculate column widths
  get sizer() {
    return this._sizer;
  }

  set sizer(val) {
    this._sizer = val;

    const meta = {
      item: this._sizer,
      renderers: null,
      originalOrder: 0,
    };
    this._itemsMeta.set(this._sizer, meta);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.innerHTML = this.columnHeaders.map(h => "<div></div>").join("");

    // add a little padding by default
    const children = [...row.children];
    for (let i = 0; i < children.length - 2; i++) {
      children[i].style.paddingRight = "10px";
    }

    this.buildRenderers(this._sizer, {elem: row});
    this.bodyElem.appendChild(row);
    meta.renderers.forEach((r, i) => {
      const cell = row.children[i].firstChild;
      r.render(cell);
    });
    const totalWidth = children.reduce((a, b) => a + b.clientWidth, 0);
    this._columnHeaders.forEach((h, i) => {
      const fixedSize = meta.renderers[i].constructor.fixedSize;
      let size = fixedSize
        ? row.children[i].clientWidth
        : row.children[i].clientWidth / totalWidth * (this.headersElem.clientWidth - 10);
      if (size < minColumnSize) {
        size = minColumnSize;
      }
      const type = fixedSize ? "explicit" : "preferred";
      this._columnSizes[h] = {size, type};
    });
    this.bodyElem.removeChild(row);
    this.calcColumnSizes();
  }
}

customElements.define("zippy-table", ZippyTable);
