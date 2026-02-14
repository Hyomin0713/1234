
"use client";
import React, { useEffect, useState } from "react";

type MeResponse = {
  user: {
    id: string;
    username: string;
  };
};

type PartyMember = {
  userId: string;
  buffs?: {
    simbi?: number;
    ppbi?: number;
    shapbi?: number;
  };
};

type Party = {
  members?: PartyMember[];
};

export default function Page() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [party, setParty] = useState<Party | null>(null);
  const [myBuffs, setMyBuffs] = useState({ simbi: 0, ppbi: 0, shapbi: 0 });

  useEffect(() => {
    if (!party || !me) return;

    const my = (party.members ?? []).find(
      (m: PartyMember) => m.userId === me.user.id
    );

    if (!my) return;

    setMyBuffs({
      simbi: Number(my.buffs?.simbi ?? 0),
      ppbi: Number(my.buffs?.ppbi ?? 0),
      shapbi: Number(my.buffs?.shapbi ?? 0),
    });
  }, [party, me]);

  return <div>Build Fix Applied</div>;
}
