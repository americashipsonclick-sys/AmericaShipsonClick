declare module 'zipcodes' {
  type ZipRecord = {
    zip: string;
    latitude: number;
    longitude: number;
    city: string;
    state: string;
    country: string;
  };
  const zipcodes: { codes: Record<string, ZipRecord> };
  export default zipcodes;
}
