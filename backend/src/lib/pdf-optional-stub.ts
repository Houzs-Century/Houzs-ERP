const unavailable = (): never => {
  throw new Error("Not available on the Worker: jsPDF html / SVG rendering needs a browser.");
};
export default unavailable;
