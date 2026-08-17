declare const ty: any;

declare module '*.module.less' {
  const classes: Record<string, string>;
  export default classes;
}
