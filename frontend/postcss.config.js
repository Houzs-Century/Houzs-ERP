import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import siblingSpacing from "./postcss-sibling-spacing.js";

export default {
  plugins: [tailwindcss(), autoprefixer(), siblingSpacing()],
};
