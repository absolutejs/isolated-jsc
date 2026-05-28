type Box<T> = {
  value: T;
};

export default function unwrapBox<T>(box: Box<T>): T {
  return box.value;
}
