declare module "picomatch" {
  export type PicomatchOptions = { dot?: boolean };
  export default function picomatch(
    pattern: string,
    options?: PicomatchOptions,
  ): (value: string) => boolean;
}
