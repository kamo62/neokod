import { create } from "zustand";

interface MissionControlUiState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useMissionControlUiStore = create<MissionControlUiState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
