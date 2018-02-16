const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      display: grid;
      grid-template-areas: "header"
                           "body";
      grid-template-rows: 32px 1fr;
      background-color: var(--zippy-table-background-color, var(--background-color));
      grid-gap: 2px;
      color: var(--zippy-table-text-color, var(--text-color));
      font-family: var(--zippy-table-font-family, var(--font-family));

      --font-family: monospace;
      --text-color: #DDD;
      --scrollbar-width: 0px;
      --background-color: #222;
      --zebra-even: #333;
      --zebra-odd: #444;
      --highlight-color: #205794;

      --row-height: 32px; /* use "row-height" attribute to set this */
    }

    :host([hide-header]) {
      grid-template-rows: 0px 1fr;
      grid-gap: 0px;
    }

    #headers {
      background-color: var(--zippy-table-zebra-even, var(--zebra-even));
      align-items: center;
      display: grid;
      overflow: hidden;
      padding-left: 5px;
      padding-right: 5px;
      height: 100%;
      grid-area: header;
    }

    #headers > div {
      overflow: hidden;
      text-overflow: ellipsis;
      height: 100%;
    }

    #body {
      overflow: auto;
      grid-area: body;
    }

    #rows {
      display: grid;
      grid-template: "grid";
    }

    /* rows  */
    #rows > div {
      padding-left: 5px;
      padding-right: 5px;
      grid-area: grid;
      display: grid;
      grid-template-rows: 1fr;
      align-items: center;
      will-change: transform; /* this improves performance _a lot_ */
      contain: strict; /* this improves performance _a lot_ with innerHTML */
      height: var(--row-height);
    }

    #rows > div:nth-child(even) {
      background-color: var(--zippy-table-zebra-even, var(--zebra-even));
    }

    #rows > div:nth-child(odd) {
      background-color: var(--zippy-table-zebra-odd, var(--zebra-odd));
    }

    #rows > div:hover {
      background-color: var(--zippy-table-highlight-color, var(--highlight-color));
    }

    /* row cells */
    #rows > div > div {
      overflow: hidden; /* changes performance profile, seems more overall gpu, but smoother */
    }
  </style>
  <div id="headers">
  </div>
  <div id="body">
    <div id="rows"></div>
  </div>
`;

const minColumnSize = 45;
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
// X selection
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
    return [
      "column-headers",
      "column-props",
      "column-renderers",
      "preload",
      "row-height",
      "hide-header",
      "disable-scroll-top-mod", // HACK/BUG: sometimes scrollTopMod is needed, other times it isn't
      "selection-type",
    ];
  }

  static addRenderer(name, rendererClass) {
    renderers[name] = rendererClass;
  }

  constructor() {
    super();

    this._selectionType = "row";

    this._columnHeaders = [];
    this._columnProps = [];
    this._columnRenderers = [];
    this._preload = true;
    this._rowHeight = 32;
    this._disableScrollTopMod = false;

    this._items = []; // raw items set by developer
    this._displayItems = []; // shallow copy of _items that we apply sorts/filtering to
    this._itemsMeta = new WeakMap(); // tracks data associated with items (ordering, renderers)
    this._sortBys = [];
    this._filter = null;
    this._columnSizes = {};
    this._selections = new Set();

    this.attachShadow({mode: "open"}).appendChild(this.constructor.template.content.cloneNode(true));

    this.headersElem = this.shadowRoot.getElementById("headers");

    this.bodyElem = this.shadowRoot.getElementById("body");

    // body resizing
    const resized = () => {
      while (this.calcRowsNeeded() > this.rows.length) {
        this.buildRow(this.rows.length);
      }

      // reset index/offsets and move back into place so that zebra order is preserved
      this.rows.forEach((r, i) => {
        if (i !== r.dataIndex) {
          this.recycleRow(r);

          r.dataIndex = i;
          r.offset = i * this._rowHeight;
        }
      });
      this.moveRows(false);

      this.forceRedraw();
    };
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => resized());
      observer.observe(this.bodyElem);
    }
    else {
      let width = this.bodyElem.clientWidth;
      let height = this.bodyElem.clientHeight;
      const resize = () => {
        // if resized
        if (this.bodyElem.clientWidth !== width || this.bodyElem.clientHeight !== height) {
          width = this.bodyElem.clientWidth;
          height = this.bodyElem.clientHeight;
          resized();
        }
        requestAnimationFrame(resize);
      };
      requestAnimationFrame(resize);
    }

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
    if (this._disableScrollTopMod) {
      scrollTopMod = 0;
    }
    // add mouse delta to scrollTop
    let scrollTop = this.bodyElem.scrollTop + scrollTopMod;
    // constrain scrollTop to bounds
    if (scrollTop < 0) {
      scrollTop = 0;
    }
    else if (scrollTop > this._items.length * this._rowHeight - this.bodyElem.clientHeight) {
      scrollTop = this._items.length * this._rowHeight - this.bodyElem.clientHeight;
    }

    this.rows.forEach(r => {
      // row is off top
      let recycled = false;

      // If going down and row is offscreen and has a valid dataIndex, recycle.
      while (!up && r.offset + this._rowHeight < scrollTop && r.dataIndex + this.rows.length < this.displayItems.length) {
        // TODO: this is potentially recycled multiple times
        this.recycleRow(r);

        r.offset += this.rows.length * this._rowHeight;
        r.dataIndex += this.rows.length;
        recycled = true;
      }
      // If going up and row is offscreen and has a valid dataIndex, recycle.
      while (up && r.offset > scrollTop + this.bodyElem.clientHeight && r.dataIndex - this.rows.length >= 0) {
        // TODO: this is potentially recycled multiple times
        this.recycleRow(r);

        r.offset -= this.rows.length * this._rowHeight;
        r.dataIndex -= this.rows.length;
        recycled = true;
      }
      // recycle/repopulate if item has been recycled and it's at a valid index
      if (recycled) {
        r.elem.style.transform = `translateY(${r.offset}px)`;
        this.populateRow(r);
      }
    });
  }

  attributeChangedCallback(name, oldVal, newVal) {
    switch (name) {
      case "column-headers":
        if (this._columnHeaders.join(",") !== newVal) {
          this.columnHeaders = newVal.split(",");
        }
        break;
      case "column-props":
        if (this._columnProps.join(",") !== newVal) {
          this.columnProps = newVal.split(",");
        }
        break;
      case "column-renderers":
        if (this._columnRenderers.join(",") !== newVal) {
          this.columnRenderers = newVal.split(",");
        }
        break;
      case "preload":
        newVal = `${newVal}`.toLowerCase() == "true";
        if (this._preload !== newVal) {
          this.preload = newVal;
        }
        break;
      case "row-height":
        newVal = parseInt(newVal);
        if (this._rowHeight !== newVal) {
          this.rowHeight = newVal;
        }
        break;
      case "hide-header":
        break;
      case "disable-scroll-top-mod":
        newVal = `${newVal}`.toLowerCase() == "true";
        if (this._disableScrollTopMod !== newVal) {
          this.disableScrollTopMod = newVal;
        }
        break;
      case "selection-type":
        if (this._selectionType !== newVal) {
          this.selectionType = newVal;
        }
        break;
    }
  }

  connectedCallback() {
  }

  calcRowsNeeded() {
    // find size and generate rows
    let numRows = Math.ceil(this.bodyElem.clientHeight / this._rowHeight) + bufferRows;
    if (numRows % 2) {
      numRows++;
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
    const offset = index * this._rowHeight;
    const row = document.createElement("div");
    row.className = "row";
    row.style.transform = `translateY(${offset}px)`;
    row.style.gridTemplateColumns = this._columnHeaders.map((h, i) => `var(--column-width-${i})`).join(" ");
    row.innerHTML = this._columnHeaders.map(h => "<div></div>").join("");
    row.addEventListener("contextmenu", event => {
      const rowElem = this.findElementByParent(event.target, this.shadowRoot.getElementById("rows"));
      const row = this.rows.find(row => row.elem === rowElem);
      this.onClick(event, row);
    });
    row.addEventListener("click", event => {
      const rowElem = this.findElementByParent(event.target, this.shadowRoot.getElementById("rows"));
      const row = this.rows.find(row => row.elem === rowElem);
      this.onClick(event, row);
    });
    this.rowsElem.appendChild(row);
    const rowData = {
      offset, // offset from top of table in pixels
      elem: row, // row div that contains all cells
      dataIndex: index, // place in list
      item: null, // ref to currently rendered item
    };
    this.rows.push(rowData);
    this.populateRow(rowData);
  }

  onClick(event, row) {
    const divIndex = this.findDivColumnIndex(event.target);
    let prop = null;
    if (divIndex !== null) {
      prop = this._columnProps[divIndex];
    }
    if (row) { // TODO: log or handle this if not true? Could it ever be false?
      if (this._selectionType === "multi-row") {
        if (event.shiftKey) {
          // bloc select.  If nothing was previously selected, select index 0 as 'start'.
          let item = null;
          this._selections.forEach(i => item = i);
          if (!item) {
            this.toggleSelections([0], {prop});
            item = this._items[0];
          }
          let start = this.displayItems.indexOf(item);
          let end = row.dataIndex;
          if (start > end) {
            [start, end] = [end, start];
          }
          this.toggleSelections([start, end], {prop, value: !!this._itemsMeta.get(item).selected});
        }
        else if (event.ctrlKey || event.metaKey) {
          // toggle select
          this.toggleSelections([row.dataIndex], {prop});
        }
        else {
          // single select
          this.clearSelections();
          this.toggleSelections([row.dataIndex], {prop});
        }
      }
      else {
        // reset and select
        this.clearSelections();
        this.toggleSelections([row.dataIndex], {prop});
      }
      this.dispatchEvent(new CustomEvent("selectionChanged", {
        detail: {
          selectedItems: this.selectedItems,
          selectedItem: this.selectedItem,
          selectedCell: {
            value: this.selectedItem[this._columnProps[divIndex]],
            prop: this._columnProps[divIndex],
          },
        },
      }));
    }
  }

  findDivColumnIndex(targetDiv) {
    if (!targetDiv.parentElement) {
      return null;
    }
    const parent = targetDiv.parentElement;
    if (parent.className === "row") {
      return Array.from(parent.children).indexOf(targetDiv);
    }
    else {
      return this.findDivColumnIndex(parent);
    }
  }

  // call when data has been manipulated (repopulate all rows)
  refresh({refreshItems = true} = {}) {
    // recycle rows
    this.rows.forEach(r => {
      this.recycleRow(r);
    });

    if (refreshItems) {
      // make sure all items have meta
      this._items.forEach(i => this.buildMeta(i));

      // rebuild _displayItems
      this._displayItems = this._items.map(i => i);

      // apply filter/sort
      this.applySort({refresh: false});
      this.applyFilter({refresh: false});

      // adjust height of container
      this.rowsElem.style.minHeight = `${this._rowHeight * this.displayItems.length}px`;
      this.moveRows(false);

      // adjust number of rows
      while (this.calcRowsNeeded() > this.rows.length) {
        const maxIndex = this.rows.reduce((a, b) => Math.max(a, b.dataIndex), 0);
        this.buildRow(maxIndex + 1);
        this.buildRow(maxIndex + 2);
      }
    }

    this.rows.forEach(r => {
      this.populateRow(r);
    });

    this.forceRedraw();
  }

  forceRedraw() {
    // HACK:
    // Sometimes rows will just disappear when updating textContent
    // Looks like a Chromium bug.
    // this forces a redraw to get around the bug

    // record scroll position
    const scrollPos = this.bodyElem.scrollTop;

    this.rowsElem.style.width = `${this.headersElem.clientWidth + 1}px`;
    this.rowsElem.style.width = `${this.headersElem.clientWidth}px`;

    // reset scroll position
    this.bodyElem.scrollTop = scrollPos;
  }

  populateRow(rowData) {
    // skip populating rows at invalid data indexes (they should be invisible)
    if (rowData.dataIndex < 0 || rowData.dataIndex >= this.displayItems.length) {
      rowData.elem.style.display = "none";
      return;
    }
    else {
      rowData.elem.style.display = "";
    }

    // initialize renderers if needed
    rowData.item = this.displayItems[rowData.dataIndex];
    const meta = this._itemsMeta.get(rowData.item);
    if (meta.selected) {
      rowData.elem.style.backgroundColor = "var(--zippy-table-highlight-color, var(--highlight-color))";
    }
    else {
      rowData.elem.style.backgroundColor = "";
    }
    this.buildRenderers(rowData.item, {meta, elem: rowData.elem});
    // run renderers
    meta.renderers.forEach((r, i) => {
      const elem = rowData.elem.children[i].firstChild;
      // TODO: implement cell selection.
      r.render(elem);
    });
  }

  recycleRow(rowData) {
    if (rowData.item) {
      this.recycleItem(rowData.elem, rowData.item);
    }
  }

  recycleItem(rowElem, item) {
    const meta = this._itemsMeta.get(item);
    meta.renderers.forEach((renderer, i) => {
      if (renderer.recycle) {
        const elem = rowElem.children[i].firstChild;
        // only recycle if renderer has run create
        if (elem) {
          renderer.recycle(elem);
        }
      }
    });
  }

  findElementByParent(source, targetParent) {
    if (source.parentNode === targetParent) {
      return source;
    }
    return source.parentNode ? this.findElementByParent(source.parentNode, targetParent) : null;
  }

  clearSelections() {
    this.rows.forEach(row => row.elem.style.backgroundColor = "");

    this._selections.forEach(item => {
      const dataIndex = this._items.indexOf(item);
      this._itemsMeta.get(this._items[dataIndex]).selected = false;
      this._itemsMeta.get(this._items[dataIndex]).selectedProp = null;
    });

    this._selections.clear();
  }

  toggleSelections([start, end], {value = null, prop = null} = {}) {
    // TODO: for Cell selection, adjust selectedProp to be an Array,
    //       and add logic for toggling individual values.
    end = end ? end : start;
    for (let dataIndex = start; dataIndex <= end; dataIndex++) {
      const item = this.displayItems[dataIndex];
      const row = this.rows.find(row => row.dataIndex === dataIndex);
      const itemMeta = this._itemsMeta.get(item);
      if (value === null) {
        if (itemMeta.selected) {
          itemMeta.selected = false;
          itemMeta.selectedProp = null;
          this._selections.delete(this.displayItems[dataIndex]);
          if (row) {
            row.elem.style.backgroundColor = "";
          }
        }
        else {
          itemMeta.selected = true;
          itemMeta.selectedProp = prop;
          this._selections.add(this.displayItems[dataIndex]);
          if (row) {
            row.elem.style.backgroundColor = "var(--zippy-table-highlight-color, var(--highlight-color))";
          }
        }
      }
      else if (value) {
          itemMeta.selected = true;
          itemMeta.selectedProp = prop;
          this._selections.add(this.displayItems[dataIndex]);
          if (row) {
            row.elem.style.backgroundColor = "var(--zippy-table-highlight-color, var(--highlight-color))";
          }
      }
      else {
          itemMeta.selected = false;
          itemMeta.selectedProp = null;
          this._selections.delete(this.displayItems[dataIndex]);
          if (row) {
            row.elem.style.backgroundColor = "";
          }
      }
    }
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
        const renderer = new renderers[r](item, this._columnProps[i], refresh => this.onItemUpdate(item, {refresh}));
        return renderer;
      });
    }
    // build dom elements if missing
    if (elem && elem.children.length && !elem.children[0].children.length) {
      meta.renderers.forEach((r, i) => {
        elem.children[i].appendChild(r.create());
      });
    }
  }

  onItemUpdate(item, {refresh = false} = {}) {
    if (refresh) {
      this.refresh({refreshItems: true});
    }
    this.dispatchEvent(new CustomEvent("itemUpdated", {detail: {item}}));
  }

  applyFilter({refresh = true, recycle = true} = {}) {
    if (refresh && recycle) {
      this.rows.forEach(r => this.recycleRow(r));
    }

    if (this._filter) {
      const displayItems = this._displayItems.filter(this._filter);
      for (const item of this.selectedItems) {
        if (!displayItems.includes(item)) {
          this.toggleSelections([this._displayItems.indexOf(item)], {value: false});
        }
      }
      this._displayItems = displayItems;
    }

    if (refresh) {
      this.refresh({refreshItems: true});
    }
  }

  // recycle is optional and should only be used when altering the sortBys
  applySort({refresh = true, recycle = true} = {}) {
    if (refresh && recycle) {
      this.rows.forEach(r => this.recycleRow(r));
    }

    // sort according to rows
    if (this._sortBys.length) {
      this._displayItems.sort((a, b) => {
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
    if (refresh) {
      this.refresh({refreshItems: false});
    }
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

  buildMeta(item, {stomp = false} = {}) {
    let meta = null;
    if (stomp || !this._itemsMeta.has(item)) {
      meta = {
        renderers: null,
        selected: false,
        selectedProp: null,
      };
      this._itemsMeta.set(item, meta);
    }

    return meta;
  }

  get selectedItems() {
    return Array.from(this._selections);
  }

  get selectedItem() {
    let item = null;
    this._selections.forEach(each => item = each);
    return item;
  }

  get selectedCell() {
    const item = this.selectedItem;
    if (item) {
      const itemMeta = this._itemsMeta.get(item);
      if (itemMeta.selectedProp) {
        return {
          value: item[itemMeta.selectedProp],
          prop: itemMeta.selectedProp,
        };
      }
    }
    return null;
  }

  get columnHeaders() {
    return this._columnHeaders;
  }

  set columnHeaders(val) {
    this._columnHeaders = val;
    this.setAttribute("column-headers", this._columnHeaders.join(","));
    this.headersElem.innerHTML = "";
    this.headersElem.style.gridTemplateColumns = this._columnHeaders.map((h, i) => `calc(var(--column-width-${i}) - var(--scrollbar-width) / ${this._columnHeaders.length})`).join(" ");
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

        // recycle items
        this.rows.forEach(r => this.recycleRow(r));

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
        this.applySort({recycle: false});
      });
      elem.appendChild(text);

      // add resize handle
      if (i !== this._columnHeaders.length - 1) {
        const resizeHandle = document.createElement("div");
        resizeHandle.style.cursor = "col-resize";
        resizeHandle.style.width = "4px";
        resizeHandle.style.backgroundColor = "var(--zippy-table-background-color, var(--background-color))";
        resizeHandle.style.height = "100%";
        resizeHandle.style.justifySelf = "flex-end";
        resizeHandle.style.marginRight = "5px";
        const onResize = event => {
          event.preventDefault();
          event.stopPropagation();
          resizing = true;
          const startX = event.pageX;
          const startWidth = elem.clientWidth;

          // follow mouse
          const onMove = event => {
            // console.log(event);
            this.setColumnSize(h, startWidth + event.pageX - startX);
          };
          const onUp = event => {
            setTimeout(() => resizing = false, 0);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
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
    this.setAttribute("column-props", this._columnProps.join(","));
  }

  get columnRenderers() {
    return this._columnRenderers;
  }

  set columnRenderers(val) {
    this._columnRenderers = val;

    // validate renderers
    const invalidRenderers = this._columnRenderers.filter(r => !renderers.hasOwnProperty(r));
    if (invalidRenderers.length) {
      console.error(`Invalid renderer/renderers assigned to table: ${invalidRenderers.join(", ")}. Using text renderer instead.`);
      invalidRenderers.forEach(r => {
        this._columnRenderers[this._columnRenderers.indexOf(r)] = "text";
      });
    }


    this.rows.forEach(r => r.renderers = null);
    this.setAttribute("column-renderers", this._columnRenderers.join(","));
  }

  get preload() {
    return this._preload;
  }

  set preload(val) {
    this._preload = val;
    this.setAttribute("preload", this._preload);
  }

  get rowHeight() {
    return this._rowHeight;
  }

  set rowHeight(val) {
    this._rowHeight = val;
    this.shadowRoot.host.style.setProperty("--row-height", `${this._rowHeight}px`);
    this.setAttribute("row-height", this._rowHeight);
  }

  get hideHeader() {
    return this.hasAttribute("hide-header");
  }

  set hideHeader(val) {
    if (val) {
      this.setAttribute("hide-header", val);
    }
    else {
      this.removeAttribute("hide-header");
    }
  }

  get selectionType() {
    return this._selectionType;
  }

  set selectionType(val) {
    this._selectionType = val;
    this.setAttribute("selection-type", val);
  }

  get disableScrollTopMod() {
    return this._disableScrollTopMod;
  }

  set disableScrollTopMod(val) {
    this._disableScrollTopMod = val;
    this.setAttribute("disable-scroll-top-mod", this._disableScrollTopMod);
  }

  // NOTE: it isn't safe to manipulate items manually outside of ZippyTable
  // removing/replacing items will desync the table
  // updating items requires a refresh call
  get items() {
    return this._items;
  }

  // NOTE: most items are indexed by ref, so there are issues if duplicates are in items
  set items(val) {
    // clean up
    this.rows.forEach(r => this.recycleRow(r));
    this.clearSelections();

    this._items = val;
    this._items.forEach((item, index) => this.buildMeta(item, {stomp: true}));

    this._displayItems = this._items.map(i => i);
    this.applySort({refresh: false});
    this.applyFilter({refresh: false});

    this.rowsElem.style.minHeight = `${this._rowHeight * this.displayItems.length}px`;
    this.buildRows();

    // pre build renderers
    // NOTE: buildIndex can be off when refresh is run if items are added/deleted
    //       renderer will be built when it is displayed anyways though
    if (this.preload) {
      const buildTarget = this._items;
      let buildIndex = this.rows.length;
      const build = deadline => {
        // stop prebuilding if items has been updated
        if (buildTarget !== this._items) {
          return;
        }
        // 2 is just an arbitrary number of milliseconds so we don't overrun the deadline
        while (deadline.timeRemaining() > 2 && buildIndex < this._items.length) {
          this.buildRenderers(this._items[buildIndex]);
          buildIndex++;
        }
        if (buildIndex < this._items.length) {
          requestIdleCallback(build);
        }
      };
      // TODO: remove requestIdleCallback check once it's supported in all browsers
      if (this.rows.length && window.requestIdleCallback) {
        requestIdleCallback(build);
      }
    }
  }

  // gets displayed item at index (could be items/displayItems depending on filtering/sorting/etc)
  get displayItems() {
    // if sorted/filtered
    if (this._sortBys.length || this._filter) {
      return this._displayItems;
    }
    else {
      return this._items;
    }
  }

  // sizer is an item used to calculate column widths
  get sizer() {
    return this._sizer;
  }

  set sizer(val) {
    this._sizer = val;

    const meta = this.buildMeta(this._sizer, {stomp: true});

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

  get filter() {
    return this._filter;
  }

  set filter(val) {
    this.rows.forEach(r => this.recycleRow(r));
    this._filter = val;
    this.applyFilter({recycle: false});
  }
}

customElements.define("zippy-table", ZippyTable);
