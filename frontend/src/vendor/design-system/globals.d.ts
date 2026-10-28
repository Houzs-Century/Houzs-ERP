// CSS Modules — Vite + tsc both understand the .module.css → typed-record import.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
