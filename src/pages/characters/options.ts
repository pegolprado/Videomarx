export const KIND_OPTIONS = [
  { value: 'realistic', label: 'Humano realista (fictício)' },
  { value: 'cinematic', label: 'Cinematográfico' },
  { value: '3d', label: '3D' },
  { value: 'cartoon', label: 'Desenho animado' },
  { value: 'anime', label: 'Anime' },
  { value: 'creature', label: 'Criatura / fantasia' },
  { value: 'mascot', label: 'Mascote de marca' },
  { value: 'avatar', label: 'Avatar estilizado' },
];

/** Somente idades adultas para personagens humanos. */
export const AGE_OPTIONS = [
  { value: '', label: 'Não se aplica / não definido' },
  { value: 'adult 18-25', label: 'Adulto jovem (18–25)' },
  { value: 'adult 26-35', label: 'Adulto (26–35)' },
  { value: 'adult 36-50', label: 'Adulto (36–50)' },
  { value: 'adult 51-65', label: 'Adulto maduro (51–65)' },
  { value: 'senior 65+', label: 'Idoso (65+)' },
];

export const APPEARANCE_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'skin', label: 'Tom de pele', placeholder: 'ex.: pele morena clara' },
  { key: 'body', label: 'Tipo físico e proporções', placeholder: 'ex.: alta, atlética' },
  { key: 'hair', label: 'Cabelo e penteado', placeholder: 'ex.: cabelo curto prateado, franja lateral' },
  { key: 'eyes', label: 'Olhos', placeholder: 'ex.: olhos violeta grandes' },
  { key: 'face', label: 'Características faciais', placeholder: 'ex.: sardas, sobrancelhas marcantes' },
  { key: 'outfit', label: 'Roupas', placeholder: 'ex.: jaqueta bomber branca com detalhes neon' },
  { key: 'shoes', label: 'Calçados', placeholder: 'ex.: tênis branco cano alto' },
  { key: 'accessories', label: 'Acessórios', placeholder: 'ex.: broche de estrela, fones' },
  { key: 'style', label: 'Estilo artístico', placeholder: 'ex.: render 3D estilo Pixar, cores vivas' },
];
