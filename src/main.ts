import initSqlJs, { type QueryExecResult, type SqlValue } from "sql.js";
import sqlJsWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

interface GalleriesInfo {
  TITLE: string;
  TITLE_JPN: string;
  GID: number;
};

type Galleries = Record<number, string>;

interface ICurrentDB {
  galleries: Galleries;
  history: number[];
  downloads: number[];
  localFavorites: number[];
}

let currentDB: ICurrentDB;

const init = async () => {
  const dbInput = $<HTMLInputElement>("#db-selector");
  
  if (!dbInput) return;
  dbInput.addEventListener("change", () => {
    const file = dbInput.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = function() {
      const u = new Uint8Array(r.result as ArrayBuffer);
      const output = $("#db-output")!;
      output.textContent = "Opening database.";
      const int = setInterval(() => {
        output.textContent += ".";
      }, 1000);
      loadFromDB(u).finally(() => clearInterval(int));
    }
    r.readAsArrayBuffer(file);
  });
  dbInput.addEventListener("click", () => {
    dbInput.value = "";
  });

  document.querySelectorAll("#dataset-options input[type=checkbox]").forEach(v => {
    v.addEventListener("change", () => {
      flushGidCount();
    });
  });

  document.querySelectorAll("#schedule-options input[type=number]").forEach(v => {
    v.addEventListener("input", () => {
      flushTimeCount();
    });
  });

  $("#generate").addEventListener("click", () => {
    generate();
  })
}

const resultToObj = (result?: QueryExecResult): Record<string, SqlValue>[] => {
  if (!result) return [];
  return result.values.map(v => {
    const obj: Record<string, SqlValue> = {};
    result.columns.forEach((col, i) => {
      obj[col] = v[i];
    })
    return obj;
  })
}

interface GenSettings {
  fromHistory: boolean;
  fromDownloads: boolean;
  fromLocalFavorites: boolean;
  weeks: number;
  coursesInDay: number;
  courseLength: number;
  breakLength: number;
  allowRepeat: boolean;
}
const collectSettings = () => {
  const result: GenSettings = {
    weeks: parseFloat($<HTMLInputElement>("#term-weeks").value) || 0,
    coursesInDay: parseFloat($<HTMLInputElement>("#courses-in-day").value) || 0,
    courseLength: parseFloat($<HTMLInputElement>("#course-elapse").value) || 0,
    breakLength: parseFloat($<HTMLInputElement>("#break-len").value) || 0,
    allowRepeat: $<HTMLInputElement>("#allow-repeat").checked,
    fromDownloads: $<HTMLInputElement>("#from-downloads").checked,
    fromHistory: $<HTMLInputElement>("#from-history").checked,
    fromLocalFavorites: $<HTMLInputElement>("#from-local-favorites").checked
  };
  return result;
}

const flushGidCount = () => {
  const size = collectGid().size;
  const output = $("#galleries-info")!;
  output.innerText = `Unique galleries: ${size}`;
}

const flushTimeCount = () => {
  const result = collectSettings();
  const infoEl = $("#schedule-info");
  infoEl.classList.remove("is-error");
  infoEl.textContent = "";
  const totalLenInDay = result.coursesInDay * (result.courseLength + result.breakLength) - result.breakLength;
  if (totalLenInDay > 24 * 60) {
    infoEl.classList.add("is-error");
    infoEl.textContent = `Error: Total course time (${totalLenInDay} minutes) > 24h`
    return;
  }
  if (result.weeks > 60 || result.weeks < 1) {
    infoEl.classList.add("is-error");
    infoEl.textContent = `Error: Weeks must between 1 ~ 60`
    return;
  }
  if (result.coursesInDay > 20 || result.coursesInDay < 1) {
    infoEl.classList.add("is-error");
    infoEl.textContent = `Error: Courses in a day must between 1 ~ 20`
    return;
  }
  const total = result.weeks * result.coursesInDay * 7;
  infoEl.textContent = `Total: ${total} courses, ${24 * 60 - totalLenInDay} minutes remain in a day`
}

const loadFromDB = async (u: Uint8Array) => {
  const output = $("#db-output");
  output.classList.remove("is-error");
  const SQL = await initSqlJs({
    locateFile() {
      return sqlJsWasmUrl;
    }
  });
  try {
    const db = new SQL.Database(u);
    const galleries = resultToObj(db.exec(`SELECT GID,TITLE,TITLE_JPN FROM GALLERIES;`)[0]) as unknown as GalleriesInfo[];
    const downloads = resultToObj(db.exec(`SELECT GID FROM DOWNLOADS;`)[0]).map(v => v.GID) as number[];
    const localFavorites = resultToObj(db.exec(`SELECT GID FROM LOCAL_FAVORITES;`)[0]).map(v => v.GID) as number[];
    const history = resultToObj(db.exec(`SELECT GID FROM HISTORY;`)[0]).map(v => v.GID) as number[];

    output.textContent = `Galleries: ${galleries.length}
History: ${history.length}
Downloads: ${downloads.length}
LocalFavorites: ${localFavorites.length}
`;
    $("#history-count")!.textContent = history.length.toString();
    $("#downloads-count")!.textContent = downloads.length.toString();
    $("#local-favorites-count")!.textContent = localFavorites.length.toString();

    const kvGalleries: Galleries = {};
    galleries.forEach(g => kvGalleries[g.GID] = g.TITLE_JPN || g.TITLE);
    currentDB = {
      galleries: kvGalleries,
      localFavorites,
      downloads,
      history
    }
    $("#generate-option").style.display = "";
    flushTimeCount();
    flushGidCount();
  } catch (e) {
    output.classList.add("is-error");
    output.textContent = e instanceof Error ? `${e.stack ?? e.message}` : String(e);
  }
}

const minToDate = (min: number) => {
  return `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
}

interface NodeTime {
  node: number;
  timeTable: number;
  startTime: string;
  endTime: string;
}

const generateBaseInfo = (id: number) => {
  const settings = collectSettings();
  return {
    "courseLen": settings.courseLength,
    "id": id,
    "name": Date.now().toString(),
    "sameBreakLen": false,
    "sameLen": true,
    "theBreakLen": 10
  }
}

const generateTimeTable = (id: number) => {
  const { coursesInDay, courseLength, breakLength } = collectSettings();
  let current = 0;
  const result: NodeTime[] = [];
  for (let i = 0; i < 20; i += 1) {
    if (i < coursesInDay) {
      result.push({
        startTime: minToDate(current),
        endTime: minToDate(current + courseLength),
        node: i + 1,
        timeTable: id
      });
      current += courseLength + breakLength;
    } else {
      result.push({
        startTime: "00:00",
        endTime: "00:01",
        node: i + 1,
        timeTable: id
      });
    }
  }
  return result;
}


const generateTableSettings = (id: number) => {
  const d = new Date();
  const settings = collectSettings();
  return {
    "background":"",
    "courseTextColor":-1,
    "id":id,
    "itemAlpha":50,
    "itemHeight":64,
    "itemTextSize":12,
    "maxWeek": settings.weeks,
    "nodes": settings.coursesInDay,
    "showOtherWeekCourse":true,
    "showSat":true,
    "showSun":true,
    "showTime":false,
    "startDate": `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`,
    "strokeColor":-2130706433,
    "sundayFirst":false,
    "tableName":"Z_" + id,
    "textColor":-16777216,
    "timeTable":id,
    "type":0,
    "widgetCourseTextColor":-1,
    "widgetItemAlpha":50,
    "widgetItemHeight":64,
    "widgetItemTextSize":12,
    "widgetStrokeColor":-2130706433,
    "widgetTextColor":-16777216
  };
}

interface Course {
  color: string;
  courseName: string;
  credit: number;
  id: number;
  note: string;
  tableId: number;
}

const collectGid = () => {
  const settings = collectSettings();
  const result = new Set<number>();
  if (settings.fromHistory) {
    currentDB.history.forEach(v => result.add(v));
  }
  if (settings.fromDownloads) {
    currentDB.downloads.forEach(v => result.add(v));
  }
  if (settings.fromLocalFavorites) {
    currentDB.localFavorites.forEach(v => result.add(v));
  }
  return result;
}

const collectGidRandom = (count: number, set: Set<number>) => {
  if (count > set.size) {
    throw new Error("Count too large");
  }
  return Array.from(set).sort(() => Math.random() > 0.5 ? 1 : -1).splice(0, count);
}

const generateCoursesList = (id: number) => {
  const settings = collectSettings();
  const count = settings.coursesInDay * 7 * settings.weeks;
  const set = collectGid();
  let inserted = 0;
  let gid: number[] = collectGidRandom(Math.min(set.size, count - inserted), set);

  const result: Course[] = gid.map(v => {
    return {
      courseName: currentDB.galleries[v],
      color: "#ffff9100",
      note: "",
      credit: 0,
      id: v,
      tableId: id
    }
  });

  return result;
}

export interface CourseTime {
  day: number
  endTime: string
  endWeek: number
  id: number
  level: number
  ownTime: boolean
  room: string
  startNode: number
  startTime: string
  startWeek: number
  step: number
  tableId: number
  teacher: string
  type: number
}


const generateCourseTime = (id: number, courses: Course[]) => {
  const settings = collectSettings();
  const count = settings.coursesInDay * 7 * settings.weeks;
  let result: CourseTime[] = [];
  const gids = courses.map(v => v.id);
  while (gids.length < count) {
    gids.push(gids[Math.floor(gids.length * Math.random())]);
  }

  result = gids.map((gid, i) => {
    return {
      id: gid,
      day: 1 + (Math.floor(i / settings.coursesInDay) % 7),
      startWeek: 1 + Math.floor(i / settings.coursesInDay / 7),
      endWeek: 1 + Math.floor(i / settings.coursesInDay / 7),
      startNode: 1 + i % settings.coursesInDay,
      tableId: id,
      teacher: "",
      step: 1,
      type: 0,
      room: "",
      level: 0,
      ownTime: false,
      startTime: "",
      endTime: "",
    }
  })
  return result;
}

const generate = () => {
  const id = Date.now() % 1000000;
  const courses = generateCoursesList(id);
  const result = `${JSON.stringify(generateBaseInfo(id))}
${JSON.stringify(generateTimeTable(id))}
${JSON.stringify(generateTableSettings(id))}
${JSON.stringify(courses)}
${JSON.stringify(generateCourseTime(id, courses))}
`
  const blob = new Blob([result], { type: "application/json"});
  if (blob.size > 512 * 1024) {
    alert("Schedule size is too large to share across network, this is the limitation of Wakeup.")
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = id + ".wakeup_schedule";
  link.click();
  URL.revokeObjectURL(url);
}

init();